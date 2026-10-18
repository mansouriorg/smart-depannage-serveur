import { Controller, Get } from '@nestjs/common';
import { ServiceZonesService } from './service-zones.service';

@Controller('service-zones')
export class ServiceZonesController {
  constructor(private readonly service: ServiceZonesService) {}

  // Public: the /rejoindre form is filled in by someone who has no account yet.
  @Get()
  list() {
    return this.service.findPublic();
  }
}
