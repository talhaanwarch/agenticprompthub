import { z } from 'zod';

/**
 * Shape of the user object attached to `req.user` and returned in API responses.
 * Does NOT include `passwordHash`.
 */
export interface UserDto {
  id: string;
  email: string;
  displayName: string | null;
}

/** Shape of a team as returned in auth responses. */
export interface TeamDto {
  id: string;
  name: string;
}

/** Response body for POST /auth/signup and POST /auth/login. */
export interface AuthResponseDto {
  user: UserDto;
  team: TeamDto;
}

/** Response body for GET /auth/me — includes roles. */
export interface MeResponseDto {
  user: UserDto;
  team: TeamDto;
  roles: string[];
}

/**
 * Zod schema for POST /auth/signup body.
 * Password minimum 8 chars; email is normalised to lowercase by transform.
 */
export const SignupSchema = z.object({
  email: z
    .string({ required_error: 'email is required.' })
    .email('Must be a valid email address.')
    .transform((v) => v.toLowerCase().trim()),
  password: z
    .string({ required_error: 'password is required.' })
    .min(8, 'Password must be at least 8 characters.'),
  displayName: z.string().optional(),
});

export type SignupDto = z.infer<typeof SignupSchema>;

/**
 * Zod schema for POST /auth/login body.
 */
export const LoginSchema = z.object({
  email: z
    .string({ required_error: 'email is required.' })
    .email('Must be a valid email address.')
    .transform((v) => v.toLowerCase().trim()),
  password: z.string({ required_error: 'password is required.' }),
});

export type LoginDto = z.infer<typeof LoginSchema>;
