// services/authService.js
const crypto = require('crypto');
const { sendEmail } = require('./emailService');
const { renderEmailTemplate } = require('../utils/templateRenderer');

class AuthService {
    constructor() {
        this.VERIFICATION_TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours
        this.PASSWORD_RESET_TOKEN_EXPIRY = 60 * 60 * 1000; // 1 hour
    }

    /**
     * Generate secure verification token
     */
    generateVerificationToken() {
        return {
            token: crypto.randomBytes(32).toString('hex'),
            expires: new Date(Date.now() + this.VERIFICATION_TOKEN_EXPIRY)
        };
    }

    /**
     * Generate password reset token
     */
    generatePasswordResetToken() {
        return {
            token: crypto.randomBytes(32).toString('hex'),
            expires: new Date(Date.now() + this.PASSWORD_RESET_TOKEN_EXPIRY)
        };
    }

    /**
     * Send verification email
     */
    async sendVerificationEmail(user, isProfileUpdate = false) {
        try {
            const { token, expires } = this.generateVerificationToken();
            const verificationLink = `${process.env.BASE_URL}/verify-email/${token}`;

            console.log('Sending verification email:', {
                email: user.email,
                isProfileUpdate: isProfileUpdate,
                verificationLink: verificationLink
            });

            const emailUserName = user.firstName || user.name;
            const subject = isProfileUpdate ? 
                'Please Verify Your New Email for Quizzie' : 
                'Please Verify Your Email for Quizzie';

            const emailHtml = await renderEmailTemplate('verificationEmail', {
                username: emailUserName,
                verificationLink: verificationLink
            });

            const emailResult = await sendEmail({
                to: user.email,
                subject: subject,
                html: emailHtml,
                text: `Hello ${emailUserName}! Please verify your email for Quizzie by clicking: ${verificationLink}. This link expires in 24 hours.`
            });

            if (emailResult.success) {
                return {
                    success: true,
                    token: token,
                    expires: expires,
                    message: 'Verification email sent successfully'
                };
            } else {
                return {
                    success: false,
                    message: emailResult.message
                };
            }

        } catch (error) {
            console.error('Error sending verification email:', error);
            return {
                success: false,
                message: 'Failed to send verification email: ' + error.message
            };
        }
    }

    /**
     * Send password reset email
     */
    async sendPasswordResetEmail(user) {
        try {
            const { token, expires } = this.generatePasswordResetToken();
            const resetLink = `${process.env.BASE_URL}/reset-password/${token}`;

            console.log('Sending password reset email:', {
                email: user.email,
                resetLink: resetLink
            });

            const emailUserName = user.firstName || user.name;

            const emailHtml = await renderEmailTemplate('resetPasswordEmail', {
                username: emailUserName,
                resetLink: resetLink
            });

            const emailResult = await sendEmail({
                to: user.email,
                subject: 'Quizzie: Password Reset Request',
                html: emailHtml,
                text: `Hello ${emailUserName},\n\nYou have requested to reset your password for your Quizzie account. Please click the following link to set a new password: ${resetLink}\n\nThis link will expire in 1 hour.\n\nIf you did not request a password reset, please ignore this email.\n\nBest regards,\nThe Quizzie Team`
            });

            if (emailResult.success) {
                return {
                    success: true,
                    token: token,
                    expires: expires,
                    message: 'Password reset email sent successfully'
                };
            } else {
                return {
                    success: false,
                    message: emailResult.message
                };
            }

        } catch (error) {
            console.error('Error sending password reset email:', error);
            return {
                success: false,
                message: 'Failed to send password reset email: ' + error.message
            };
        }
    }

    /**
     * Validate password strength
     */
    validatePassword(password) {
        const errors = [];

        if (!password) {
            errors.push('Password is required');
            return { isValid: false, errors };
        }

        if (password.length < 6) {
            errors.push('Password must be at least 6 characters long');
        }

        // Add more validation rules as needed
        // if (!/[A-Z]/.test(password)) {
        //     errors.push('Password must contain at least one uppercase letter');
        // }

        return {
            isValid: errors.length === 0,
            errors: errors
        };
    }

    /**
     * Validate email format
     */
    validateEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }

    /**
     * Check if token is expired
     */
    isTokenExpired(tokenExpiry) {
        return new Date() > new Date(tokenExpiry);
    }

    /**
     * Create user session data
     */
    createUserSession(user, userType) {
        return {
            userId: user._id,
            userName: user.name || `${user.firstName} ${user.lastName}`.trim(),
            userType: userType,
            email: user.email,
            isVerified: user.isVerified,
            loginTime: new Date()
        };
    }

    /**
     * Handle profile email update with verification
     */
    async handleEmailUpdate(user, newEmail, userType) {
        try {
            // Validate new email
            if (!this.validateEmail(newEmail)) {
                return {
                    success: false,
                    message: 'Please enter a valid email address format.'
                };
            }

            // Check if email is already in use
            const { studentCollection, teacherCollection } = require('../mongodb');
            
            const existingStudentWithEmail = await studentCollection.findOne({ 
                email: newEmail, 
                _id: { $ne: user._id } 
            });
            const existingTeacherWithEmail = await teacherCollection.findOne({ 
                email: newEmail 
            });

            if (existingStudentWithEmail || existingTeacherWithEmail) {
                return {
                    success: false,
                    message: 'This email is already registered to another account.'
                };
            }

            // Send verification email to new address
            const tempUser = { ...user.toObject(), email: newEmail };
            const emailResult = await this.sendVerificationEmail(tempUser, true);

            if (emailResult.success) {
                // Store pending email and verification token
                user.pendingEmail = newEmail;
                user.isVerified = false;
                user.verificationToken = emailResult.token;
                user.verificationTokenExpires = emailResult.expires;
                
                await user.save();

                return {
                    success: true,
                    message: 'A verification link has been sent to your new email address. Please click the link to confirm the change.'
                };
            } else {
                return {
                    success: false,
                    message: `Failed to send verification email to new address: ${emailResult.message}. Your email has not been changed.`
                };
            }

        } catch (error) {
            console.error('Error handling email update:', error);
            return {
                success: false,
                message: 'An unexpected error occurred while updating email: ' + error.message
            };
        }
    }

    /**
     * Verify email token and update user
     */
    async verifyEmailToken(token) {
        try {
            const { studentCollection, teacherCollection } = require('../mongodb');

            // Try to find user in both collections
            let user = await studentCollection.findOne({
                verificationToken: token,
                verificationTokenExpires: { $gt: Date.now() }
            });

            if (!user) {
                user = await teacherCollection.findOne({
                    verificationToken: token,
                    verificationTokenExpires: { $gt: Date.now() }
                });
            }

            if (!user) {
                return {
                    success: false,
                    message: 'The verification link is invalid or has expired. Please try resending the verification email.'
                };
            }

            // Check if this is a pending email verification
            if (user.pendingEmail && user.verificationToken === token) {
                // This is a pending email change, apply it now
                user.email = user.pendingEmail;
                user.pendingEmail = undefined;
                user.isVerified = true;
                user.verificationToken = undefined;
                user.verificationTokenExpires = undefined;
                await user.save();

                console.log(`User ${user.email} (new) email successfully updated and verified.`);
                return {
                    success: true,
                    message: 'Your email address has been successfully updated and verified!'
                };
            }
            // This handles initial registration verification
            else if (!user.isVerified && !user.pendingEmail && user.verificationToken === token) {
                user.isVerified = true;
                user.verificationToken = undefined;
                user.verificationTokenExpires = undefined;
                await user.save();

                console.log(`User ${user.email} (initial) email successfully verified.`);
                return {
                    success: true,
                    message: 'Your email has been successfully verified! You can now log in.'
                };
            }
            // If already verified (and no pending email)
            else if (user.isVerified) {
                return {
                    success: false,
                    message: 'Your email address is already verified. No action needed.'
                };
            }
            else {
                return {
                    success: false,
                    message: 'An unexpected error occurred during verification. Please try again.'
                };
            }

        } catch (error) {
            console.error('Error verifying email token:', error);
            return {
                success: false,
                message: 'An internal server error occurred during verification. Please try again later.'
            };
        }
    }

    /**
     * Handle password reset
     */
    async resetPassword(token, newPassword, confirmPassword) {
        try {
            // Validate passwords match
            if (newPassword !== confirmPassword) {
                return {
                    success: false,
                    message: 'Passwords do not match.'
                };
            }

            // Validate password strength
            const passwordValidation = this.validatePassword(newPassword);
            if (!passwordValidation.isValid) {
                return {
                    success: false,
                    message: passwordValidation.errors.join(', ')
                };
            }

            const { studentCollection, teacherCollection } = require('../mongodb');

            // Find user with valid reset token
            let user = await studentCollection.findOne({
                resetPasswordToken: token,
                resetPasswordTokenExpires: { $gt: Date.now() }
            });

            if (!user) {
                user = await teacherCollection.findOne({
                    resetPasswordToken: token,
                    resetPasswordTokenExpires: { $gt: Date.now() }
                });
            }

            if (!user) {
                return {
                    success: false,
                    message: 'The password reset link is invalid or has expired. Please request a new one.'
                };
            }

            // Update password and clear token fields
            user.password = newPassword; // WARNING: Storing plain text for testing
            user.resetPasswordToken = undefined;
            user.resetPasswordTokenExpires = undefined;
            await user.save();

            console.log(`User ${user.email} password successfully reset.`);
            return {
                success: true,
                message: 'Your password has been successfully reset! You can now log in with your new password.'
            };

        } catch (error) {
            console.error('Error resetting password:', error);
            return {
                success: false,
                message: 'An unexpected error occurred while resetting password. Please try again.'
            };
        }
    }
}

// Export singleton instance
const authService = new AuthService();
module.exports = authService;