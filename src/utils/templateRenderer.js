// utils/templateRenderer.js - Fixed template path
const path = require('path');
const hbs = require('handlebars');
const fs = require('fs').promises; // Use promises version for async/await

async function renderEmailTemplate(templateName, data) {
    try {
        // Fixed path to point to correct templates directory
        const templatePath = path.join(__dirname, '..', '..', 'tempelates', 'emails', `${templateName}.hbs`);

        console.log('Attempting to read template from:', templatePath);
        
        const templateContent = await fs.readFile(templatePath, 'utf8');
        const template = hbs.compile(templateContent);
        return template(data);
    } catch (error) {
        console.error(`Error rendering email template ${templateName}:`, error);
        console.error('Template path attempted:', path.join(__dirname, '..', '..', 'tempelates', 'emails', `${templateName}.hbs`));
        
        // Return a fallback template if the file is not found
        if (error.code === 'ENOENT') {
            console.log('Template file not found, using fallback template');
            return createFallbackTemplate(templateName, data);
        }
        
        throw new Error(`Failed to render email template: ${templateName}`);
    }
}

// Fallback templates for when email template files are missing
function createFallbackTemplate(templateName, data) {
    switch (templateName) {
        case 'verificationEmail':
            return `
                <html>
                <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                    <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                        <h2 style="color: #4CAF50;">Email Verification Required</h2>
                        <p>Hello ${data.username || 'User'},</p>
                        <p>Please verify your email address by clicking the link below:</p>
                        <p><a href="${data.verificationLink}" style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">Verify Email</a></p>
                        <p>If the button doesn't work, copy and paste this link in your browser:</p>
                        <p>${data.verificationLink}</p>
                        <p>This link will expire in 24 hours.</p>
                        <p>Best regards,<br>The Quizzie Team</p>
                    </div>
                </body>
                </html>
            `;
        
        case 'resetPasswordEmail':
            return `
                <html>
                <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                    <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                        <h2 style="color: #FF6B6B;">Password Reset Request</h2>
                        <p>Hello ${data.username || 'User'},</p>
                        <p>You have requested to reset your password. Click the link below to set a new password:</p>
                        <p><a href="${data.resetLink}" style="background-color: #FF6B6B; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">Reset Password</a></p>
                        <p>If the button doesn't work, copy and paste this link in your browser:</p>
                        <p>${data.resetLink}</p>
                        <p>This link will expire in 1 hour.</p>
                        <p>If you did not request a password reset, please ignore this email.</p>
                        <p>Best regards,<br>The Quizzie Team</p>
                    </div>
                </body>
                </html>
            `;
        
        default:
            return `
                <html>
                <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                    <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                        <h2>Notification from Quizzie</h2>
                        <p>Hello ${data.username || 'User'},</p>
                        <p>This is an automated email from Quizzie.</p>
                        <p>Best regards,<br>The Quizzie Team</p>
                    </div>
                </body>
                </html>
            `;
    }
}

module.exports = { renderEmailTemplate };