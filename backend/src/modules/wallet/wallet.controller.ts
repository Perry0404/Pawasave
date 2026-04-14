import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { WalletService } from './wallet.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { IsNumberString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

class AmountDto {
  @ApiProperty({ example: '500000', description: 'Amount in kobo' })
  @IsNumberString()
  amountKobo: string;
}

@ApiTags('Wallet')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get('dashboard')
  getDashboard(@CurrentUser() user: { userId: string }) {
    return this.walletService.getDashboard(user.userId);
  }

  @Post('save')
  saveToVault(@CurrentUser() user: { userId: string }, @Body() dto: AmountDto) {
    return this.walletService.saveToVault(user.userId, BigInt(dto.amountKobo));
  }

  @Post('withdraw')
  withdrawFromVault(@CurrentUser() user: { userId: string }, @Body() dto: AmountDto) {
    return this.walletService.withdrawFromVault(user.userId, BigInt(dto.amountKobo));
  }
}
