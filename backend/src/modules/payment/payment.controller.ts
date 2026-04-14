import { Controller, Post, Get, Body, Query, Headers, UseGuards, RawBodyRequest, Req } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PaymentService } from './payment.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { IsNumberString, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { createHmac } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

class SimulatePaymentDto {
  @ApiProperty({ example: '1000000', description: 'Amount in kobo (₦10,000 = 1000000)' })
  @IsNumberString()
  amountKobo: string;
}

@ApiTags('Payments')
@Controller('api/payments')
export class PaymentController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly config: ConfigService,
  ) {}

  /** Paystack webhook (public — verified by signature) */
  @Post('webhook/paystack')
  async paystackWebhook(
    @Body() body: any,
    @Headers('x-paystack-signature') signature: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const secret = this.config.get<string>('PAYSTACK_SECRET_KEY', '');
    const rawBody = req.rawBody;
    if (rawBody) {
      const hash = createHmac('sha512', secret).update(rawBody).digest('hex');
      if (hash !== signature) {
        return { status: 'invalid signature' };
      }
    }

    await this.paymentService.handlePaystackWebhook(body);
    return { status: 'ok' };
  }

  /** Simulate a payment (dev/testing) */
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @Post('simulate')
  simulatePayment(
    @CurrentUser() user: { userId: string },
    @Body() dto: SimulatePaymentDto,
  ) {
    return this.paymentService.handleIncomingPayment(
      user.userId,
      BigInt(dto.amountKobo),
      'INTERNAL',
    );
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @Get('history')
  getHistory(
    @CurrentUser() user: { userId: string },
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.paymentService.getPaymentHistory(
      user.userId,
      limit ? parseInt(limit, 10) : 50,
      offset ? parseInt(offset, 10) : 0,
    );
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @Get('transactions')
  getTransactions(
    @CurrentUser() user: { userId: string },
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.paymentService.getTransactions(
      user.userId,
      limit ? parseInt(limit, 10) : 50,
      offset ? parseInt(offset, 10) : 0,
    );
  }
}
