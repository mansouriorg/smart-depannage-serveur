import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthCredentialsDto } from './dto/auth-credentials.dto';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  // POST /auth/register
  @Post('register')
  async register(@Body() credentialsDto: AuthCredentialsDto) {
    return this.authService.register(credentialsDto);
  }

  // POST /auth/login
  @HttpCode(HttpStatus.OK) // Sets status to 200 (default is 201 for POST)
  @Post('login')
  async login(@Body() credentialsDto: AuthCredentialsDto) {
    // 1. Validate user and get the user object (or null)
    const user = await this.authService.validateUser(
      credentialsDto.email, 
      credentialsDto.password
    );

    // 2. If valid, generate and return the JWT
    if (!user) {
      // You can throw an exception here, but usually the service handles it 
      // or returns null. Ideally, validateUser should handle the logic.
      // However, for cleaner controller logic:
      throw new Error('Invalid credentials'); // Or use UnauthorizedException
    }
    
    return this.authService.login(user);
  }
}