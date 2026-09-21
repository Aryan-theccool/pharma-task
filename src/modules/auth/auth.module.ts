import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { PasswordService } from '../../common/crypto/password.service';

/**
 * Global so the app-wide JwtAuthGuard (registered in AppModule) can inject
 * JwtService without every feature module re-importing JwtModule.
 */
@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, FieldEncryptionService, PasswordService],
  exports: [AuthService, FieldEncryptionService, PasswordService, JwtModule],
})
export class AuthModule {}
