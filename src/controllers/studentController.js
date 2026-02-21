const { studentCollection, quizResultCollection, classCollection } = require('../mongodb');
const fs = require('fs');
const path = require('path');

class StudentController {

    // Change Password
    static changePassword = async (req, res) => {
        try {
            const { oldPassword, newPassword, confirmNewPassword } = req.body;
            const studentId = req.session.userId;

            if (newPassword !== confirmNewPassword) {
                return res.redirect('/profileStudent?error=' + encodeURIComponent('New passwords do not match.'));
            }

            const student = await studentCollection.findById(studentId);

            // Simple password check (plaintext as per current system design - SHOULD BE HASHED IN FUTURE)
            if (student.password !== oldPassword) {
                return res.redirect('/profileStudent?error=' + encodeURIComponent('Incorrect old password.'));
            }

            student.password = newPassword;
            await student.save();

            res.redirect('/profileStudent?message=' + encodeURIComponent('Password changed successfully.'));

        } catch (error) {
            console.error('Error changing password:', error);
            res.redirect('/profileStudent?error=' + encodeURIComponent('Failed to change password.'));
        }
    };

    // Update Notification Settings
    static updateNotificationSettings = async (req, res) => {
        try {
            const studentId = req.session.userId;
            const { emailNotifications, marketingNotifications } = req.body;

            await studentCollection.findByIdAndUpdate(studentId, {
                notificationPreferences: {
                    email: !!emailNotifications,
                    marketing: !!marketingNotifications
                }
            });

            res.redirect('/profileStudent?message=' + encodeURIComponent('Notification settings updated.'));

        } catch (error) {
            console.error('Error updating notification settings:', error);
            res.redirect('/profileStudent?error=' + encodeURIComponent('Failed to update settings.'));
        }
    };

    // Download Student Data
    static downloadData = async (req, res) => {
        try {
            const studentId = req.session.userId;
            const student = await studentCollection.findById(studentId).lean();
            const quizResults = await quizResultCollection.find({ studentId: studentId }).lean();

            // Basic data aggregation
            const data = {
                profile: {
                    name: student.name,
                    email: student.email,
                    enrollment: student.enrollment,
                    joinedAt: student.createdAt
                },
                quizResults: quizResults.map(q => ({
                    quizId: q.quizId,
                    score: q.score,
                    percentage: q.percentage,
                    date: q.submissionDate
                }))
            };

            const jsonData = JSON.stringify(data, null, 2);
            const fileName = `student_data_${student.enrollment}.json`;

            res.setHeader('Content-disposition', 'attachment; filename=' + fileName);
            res.setHeader('Content-type', 'application/json');
            res.write(jsonData, function (err) {
                res.end();
            });

        } catch (error) {
            console.error('Error downloading data:', error);
            res.redirect('/profileStudent?error=' + encodeURIComponent('Failed to download data.'));
        }
    };
}

module.exports = StudentController;
