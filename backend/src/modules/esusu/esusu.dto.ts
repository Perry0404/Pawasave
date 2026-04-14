import { IsString, IsOptional, IsInt, IsEnum, Min, Max, IsNumberString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateEsusuGroupDto {
  @ApiProperty({ example: 'Spare Parts Ajo' })
  @IsString()
  name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: '5000000', description: 'Contribution per cycle in kobo' })
  @IsNumberString()
  contributionAmountKobo: string;

  @ApiProperty({ enum: ['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY'] })
  @IsEnum(['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY'] as const)
  cyclePeriod: string;

  @ApiProperty({ example: 10 })
  @IsInt()
  @Min(2)
  @Max(50)
  maxMembers: number;

  @ApiProperty({ enum: ['USDC', 'NAIRA'], default: 'USDC' })
  @IsOptional()
  @IsEnum(['USDC', 'NAIRA'] as const)
  savingsMode?: string;

  @ApiProperty({ example: 500, description: 'Emergency pot percentage in bps (500 = 5%)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2000)
  emergencyPotBps?: number;
}

export class ContributeDto {
  @ApiProperty({ example: 'group-uuid' })
  @IsString()
  groupId: string;
}

export class EmergencyRequestDto {
  @ApiProperty({ example: 'group-uuid' })
  @IsString()
  groupId: string;

  @ApiProperty({ example: 'Medical emergency — hospital bill' })
  @IsString()
  reason: string;

  @ApiProperty({ example: '2000000', description: 'Requested amount in kobo' })
  @IsNumberString()
  amountKobo: string;
}

export class EmergencyVoteDto {
  @ApiProperty({ example: 'request-uuid' })
  @IsString()
  requestId: string;

  @ApiProperty({ example: true })
  approve: boolean;
}
