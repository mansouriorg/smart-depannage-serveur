import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  // 1. Send SMS (Simulation)
  async sendSms(phoneNumber: string, message: string) {
    // In production, you would use Twilio here:
    // await this.twilioClient.messages.create({ to: phoneNumber, body: message ... })
    
    this.logger.log(`📱 [SMS SIMULATION] To: ${phoneNumber} | Message: "${message}"`);
    return true;
  }

  // 2. Send Email (Simulation)
  async sendEmail(email: string, subject: string, content: string) {
    // In production, you would use SendGrid/Nodemailer here
    
    this.logger.log(`📧 [EMAIL SIMULATION] To: ${email} | Subject: "${subject}"`);
    this.logger.log(`   Body: "${content}"`);
    return true;
  }

  // 3. Notify Artisan of New Job
  async notifyArtisan(artisanPhone: string, jobDescription: string) {
    const msg = `Nouvelle mission disponible: ${jobDescription}. Connectez-vous pour accepter.`;
    return this.sendSms(artisanPhone, msg);
  }

  // 4. Notify Client of Acceptance
  async notifyClient(clientPhone: string, artisanName: string) {
    const msg = `Bonne nouvelle! ${artisanName} a accepté votre demande et est en route.`;
    return this.sendSms(clientPhone, msg);
  }
}