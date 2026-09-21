import type { Request } from 'express';

export type UserRole = 'patient' | 'doctor' | 'admin' | 'support';

export interface JwtPayload {
  sub: string;
  role: UserRole;
  mfa: boolean;
  /** Elevated when the session completed an MFA challenge (step-up auth). */
  amr: string[];
  sid?: string;
  iat?: number;
  exp?: number;
}

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
  requestId?: string;
}

export interface AuthenticatedUser extends JwtPayload {
  doctorId?: string;
}
