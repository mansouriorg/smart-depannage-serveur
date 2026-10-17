// The real DTO lives in notification.dto.ts. This file used to hold an empty
// class, so the validation pipe (whitelist + forbidNonWhitelisted) refused every
// field and POST /notifications could not work.
export { CreateNotificationDto } from './notification.dto';
