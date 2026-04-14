import { Controller, Post, Get, Body, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { EsusuService } from './esusu.service';
import { EmergencyService } from './emergency.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateEsusuGroupDto, ContributeDto, EmergencyRequestDto, EmergencyVoteDto } from './esusu.dto';

@ApiTags('Esusu / Ajo')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/esusu')
export class EsusuController {
  constructor(
    private readonly esusuService: EsusuService,
    private readonly emergencyService: EmergencyService,
  ) {}

  @Post('create')
  createGroup(@CurrentUser() user: { userId: string }, @Body() dto: CreateEsusuGroupDto) {
    return this.esusuService.createGroup(user.userId, dto);
  }

  @Post('join/:groupId')
  joinGroup(@CurrentUser() user: { userId: string }, @Param('groupId') groupId: string) {
    return this.esusuService.joinGroup(user.userId, groupId);
  }

  @Post('contribute')
  contribute(@CurrentUser() user: { userId: string }, @Body() dto: ContributeDto) {
    return this.esusuService.contribute(user.userId, dto.groupId);
  }

  @Get('my-groups')
  getMyGroups(@CurrentUser() user: { userId: string }) {
    return this.esusuService.getUserGroups(user.userId);
  }

  @Get('group/:groupId')
  getGroup(@Param('groupId') groupId: string) {
    return this.esusuService.getGroup(groupId);
  }

  @Post('quick-ajo')
  quickAjo(
    @CurrentUser() user: { userId: string },
    @Body() body: { tradeLine: string; memberCount: number },
  ) {
    return this.esusuService.quickCreateMarketAjo(user.userId, body.tradeLine, body.memberCount);
  }

  // ─── Emergency Pot ───

  @Post('emergency/request')
  requestEmergency(@CurrentUser() user: { userId: string }, @Body() dto: EmergencyRequestDto) {
    return this.emergencyService.requestEmergency(
      user.userId,
      dto.groupId,
      dto.reason,
      BigInt(dto.amountKobo),
    );
  }

  @Post('emergency/vote')
  voteEmergency(@CurrentUser() user: { userId: string }, @Body() dto: EmergencyVoteDto) {
    return this.emergencyService.vote(user.userId, dto.requestId, dto.approve);
  }

  @Get('emergency/:requestId')
  getEmergencyRequest(@Param('requestId') requestId: string) {
    return this.emergencyService.getRequest(requestId);
  }

  @Get('group/:groupId/emergencies')
  getGroupEmergencies(@Param('groupId') groupId: string) {
    return this.emergencyService.getGroupEmergencies(groupId);
  }
}
