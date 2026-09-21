import { Controller, Get, Header, Res, ServiceUnavailableException } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { DatabaseService } from '../../infra/database.service';
import { RedisService } from '../../infra/redis.service';
import { Public } from '../../common/decorators/public.decorator';
import { metrics } from '../../observability/metrics';

/**
 * Liveness vs readiness are deliberately different:
 *  - /healthz   never touches a dependency. A failing DB must not make
 *               Kubernetes/ECS kill an otherwise healthy process.
 *  - /readyz    deep-checks Postgres and Redis, so the load balancer stops
 *               sending traffic while a dependency is down, without a restart
 *               loop.
 */
@ApiTags('ops')
@Controller()
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get('healthz')
  @ApiOperation({ summary: 'Liveness probe (no dependency checks)' })
  liveness() {
    return {
      status: 'ok',
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      version: process.env.npm_package_version ?? '1.0.0',
      timestamp: new Date().toISOString(),
    };
  }

  @Public()
  @Get('readyz')
  @ApiOperation({ summary: 'Readiness probe (deep-checks Postgres and Redis)' })
  async readiness() {
    const checks: Record<string, { status: string; latencyMs?: number; error?: string }> = {};

    for (const [name, probe] of [
      ['postgres', () => this.db.healthCheck()],
      ['redis', () => this.redis.healthCheck()],
    ] as const) {
      const start = Date.now();
      try {
        const ok = await probe();
        checks[name] = { status: ok ? 'up' : 'down', latencyMs: Date.now() - start };
      } catch (error) {
        checks[name] = { status: 'down', error: (error as Error).message };
      }
    }

    const healthy = Object.values(checks).every((c) => c.status === 'up');
    const body = {
      status: healthy ? 'ready' : 'not_ready',
      checks,
      pool: this.db.poolStats,
      timestamp: new Date().toISOString(),
    };
    if (!healthy) throw new ServiceUnavailableException(body);
    return body;
  }

  @Public()
  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  @ApiExcludeEndpoint()
  async metrics(@Res() res: Response) {
    res.setHeader('Content-Type', metrics.contentType);
    res.send(await metrics.scrape());
  }
}
