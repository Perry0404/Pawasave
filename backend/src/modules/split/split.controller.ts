import { Controller, Post, Get, Delete, Patch, Body, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { SplitService } from './split.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { IsString, IsArray, ValidateNested, IsInt, IsOptional, IsNumberString, IsBoolean, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

class AllocationDto {
  @ApiProperty({ enum: ['PERSONAL_VAULT', 'NAIRA_BALANCE', 'ESUSU_GROUP'] })
  @IsString()
  target: string;

  @ApiProperty({ example: 6000, description: 'Percentage in bps (6000 = 60%)' })
  @IsInt()
  @Min(0)
  @Max(10000)
  percentage: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  esusuGroupId?: string;
}

class CreateSplitRuleDto {
  @ApiProperty({ example: 'Default Split' })
  @IsString()
  name: string;

  @ApiProperty({ example: '0', description: 'Min payment amount in kobo to trigger (0 = always)' })
  @IsNumberString()
  minAmountKobo: string;

  @ApiProperty({ type: [AllocationDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AllocationDto)
  allocations: AllocationDto[];
}

class ToggleRuleDto {
  @IsBoolean()
  isActive: boolean;
}

@ApiTags('Smart Split')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/split')
export class SplitController {
  constructor(private readonly splitService: SplitService) {}

  @Post('rules')
  createRule(@CurrentUser() user: { userId: string }, @Body() dto: CreateSplitRuleDto) {
    return this.splitService.createRule(
      user.userId,
      dto.name,
      BigInt(dto.minAmountKobo),
      dto.allocations,
    );
  }

  @Get('rules')
  getRules(@CurrentUser() user: { userId: string }) {
    return this.splitService.getRules(user.userId);
  }

  @Patch('rules/:ruleId')
  toggleRule(
    @CurrentUser() user: { userId: string },
    @Param('ruleId') ruleId: string,
    @Body() dto: ToggleRuleDto,
  ) {
    return this.splitService.toggleRule(user.userId, ruleId, dto.isActive);
  }

  @Delete('rules/:ruleId')
  deleteRule(@CurrentUser() user: { userId: string }, @Param('ruleId') ruleId: string) {
    return this.splitService.deleteRule(user.userId, ruleId);
  }
}
