import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
  ) {}

  // 1. Validate User (Check Email & Password)
  async validateUser(email: string, pass: string): Promise<any> {
    const user = await this.usersService.findOneByEmail(email);
    
    // If user not found, return null
    if (!user) {
      return null;
    }

    // Verify the password using Argon2
    const isPasswordValid = await argon2.verify(user.password, pass);
    
    if (isPasswordValid) {
      // ⚠️ Important: Strip the password before returning the user object
      const { password, ...result } = user;
      return result;
    }

    return null;
  }

  // 2. Login (Generate JWT Token)
  async login(user: any) {
    // The payload is the data inside the token. 
    // We put the user's ID (sub) and Email.
    const payload = { email: user.email, sub: user.id, role: user.role };
    
    return {
      access_token: this.jwtService.sign(payload),
    };
  }

  // 3. Register (Proxy to UsersService)
  async register(userDto: any) {
    return this.usersService.create(userDto);
  }
}