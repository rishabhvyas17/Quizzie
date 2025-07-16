// backend/src/services/emailService.js

const SibApiV3Sdk = require('sib-api-v3-sdk');
// --- CRITICAL DEBUG LOGS ---
console.log('DEBUG: emailService.js loaded.');
console.log('DEBUG: process.env.BREVO_API_KEY (in emailService):', process.env.BREVO_API_KEY ? '*****' + process.env.BREVO_API_KEY.substring(process.env.BREVO_API_KEY.length - 5) : 'NOT SET'); // Logs last 5 chars for security
console.log('DEBUG: process.env.SENDER_EMAIL (in emailService):', process.env.SENDER_EMAIL);
// --- END CRITICAL DEBUG LOGS ---
// IMPORTANT: Configure API key once globally for the SDK's default client.
// This should ideally be done at application startup, but placing it here
// ensures it's configured before any email is sent.
var defaultClient = SibApiV3Sdk.ApiClient.instance;
var apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY; // Set your API key from environment variables

const sendEmail = async ({ to, subject, html, text }) => {
    console.log('DEBUG: Attempting to send email...');
    console.log('DEBUG: SENDER_EMAIL used:', process.env.SENDER_EMAIL);
    console.log('DEBUG: Recipient:', to);
    console.log('DEBUG: Subject:', subject);

    try {
        const sendSmtpEmail = {
            to: [{ email: to }],
            sender: { email: process.env.SENDER_EMAIL },
            subject: subject,
            htmlContent: html,
            textContent: text, // Provide a plain text version for better deliverability
        };

        // Create the TransactionalEmailsApi instance.
        // It will now automatically use the API key configured on defaultClient.
        const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
        
        // REMOVE THE LINE BELOW - IT IS INCORRECT AND CAUSING THE ERROR
        // apiInstance.setApiKey(SibApiV3Sdk.TransactionalEmailsApi.ApiKey.General, process.env.BREVO_API_KEY);

        const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log('Email sent successfully to:', to, 'with subject:', `"${subject}"`);
        console.log('DEBUG: Brevo API response:', data); // Log the full Brevo response
        return { success: true, message: 'Email sent successfully!' };

    } catch (error) {
        console.error('❌ Full Error Object from Brevo SDK:', JSON.stringify(error, null, 2)); // CRITICAL: Log full error for debugging
        console.error('❌ Top-level error message:', error.message);

        let userFriendlyMessage = 'Failed to send email. An unexpected error occurred.'; // Default generic message

        // Prioritize specific Brevo API response body if available
        if (error.response && error.response.body) {
            const brevoErrorBody = error.response.body;
            console.error('Brevo API Response Body (parsed):', brevoErrorBody);

            if (brevoErrorBody.code === 'invalid_parameter' && brevoErrorBody.message && brevoErrorBody.message.includes('email is not valid in to')) {
                userFriendlyMessage = 'The email address you provided is not valid or cannot be delivered to. Please check the format or try a different email.';
            } else if (brevoErrorBody.message) {
                // Catch other specific messages from Brevo's API response
                userFriendlyMessage = `Email sending failed: ${brevoErrorBody.message}.`;
            } else {
                userFriendlyMessage = 'Email sending failed due to an unknown issue with the email service. No specific message from Brevo.';
            }
        } else if (error.message && error.message.includes('timeout')) {
            userFriendlyMessage = 'Email service connection timed out. Please check your internet connection or try again later.';
        } else if (error.message) {
            // Catch other general JavaScript errors or network issues before API response
            userFriendlyMessage = `An unexpected error occurred: ${error.message}.`;
        }

        return { success: false, message: userFriendlyMessage };
    }
};

module.exports = { sendEmail };