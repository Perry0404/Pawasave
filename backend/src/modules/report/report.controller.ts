import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ReportService } from './report.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Reports & Insights')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/reports')
export class ReportController {
  constructor(private readonly reportService: ReportService) {}

  @Get('daily')
  getDailyReport(@CurrentUser() user: { userId: string }) {
    return this.reportService.generateDailyReport(user.userId);
  }

  @Get('trend')
  getSalesTrend(
    @CurrentUser() user: { userId: string },
    @Query('days') days?: string,
  ) {
    return this.reportService.getSalesTrend(
      user.userId,
      days ? parseInt(days, 10) : 30,
    );
  }
}
