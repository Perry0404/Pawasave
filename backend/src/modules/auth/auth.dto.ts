import { IsString, IsOptional, IsEmail, MinLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: '08012345678' })
  @IsString()
  @Matches(/^0[7-9][01]\d{8}$/, { message: 'Invalid Nigerian phone number' })
  phone: string;

  @ApiProperty({ example: 'StrongP@ss1' })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ required: false, example: 'Mama Nkechi Store' })
  @IsOptional()
  @IsString()
  businessName?: string;

  @ApiProperty({ required: false, example: 'Nkechi' })
  @IsOptional()
  @IsString()
  displayName?: string;
}

export class LoginDto {
  @ApiProperty({ example: '08012345678' })
  @IsString()
  phone: string;

  @ApiProperty({ example: 'StrongP@ss1' })
  @IsString()
  password: string;
}
