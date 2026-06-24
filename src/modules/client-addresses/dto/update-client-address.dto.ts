import { PartialType } from '@nestjs/mapped-types';
import { CreateClientAddressDto } from './create-client-address.dto';

export class UpdateClientAddressDto extends PartialType(CreateClientAddressDto) {}