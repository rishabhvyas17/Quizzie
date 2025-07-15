// backend/src/models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    userName: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    password: { // IMPORTANT: This will store PLAIN TEXT passwords for now.
                // THIS IS A MAJOR SECURITY RISK FOR PRODUCTION.
                // YOU MUST IMPLEMENT HASHING (e.g., using bcryptjs) LATER.
        type: String,
        required: true
    },
    role: {
        type: String,
        enum: ['student', 'teacher', 'admin', 'super_admin', 'institute_admin'],
        required: true
    },
    email: { // CRUCIAL: Email field for all users (including students)
        type: String,
        required: true, // Make email required for all users
        unique: true,   // Ensure email is unique across all users
        trim: true,
        lowercase: true,
        match: [/.+@.+\..+/, 'Please fill a valid email address']
    },
    isVerified: { // For email verification
        type: Boolean,
        default: false
    },
    verificationToken: String,
    verificationTokenExpires: Date,
    resetPasswordToken: String, // For password reset (will implement later)
    resetPasswordTokenExpires: Date, // For password reset (will implement later)

    // Existing fields (adjust as per your current setup)
    studentEnrollment: { // Example: for student role
        type: String,
        unique: true,
        sparse: true // Allows null values to not violate unique constraint for non-students
    },
    instituteId: { // Crucial for multi-tenancy, links user to an institute
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Institute', // Assuming you have an Institute model
        required: function() {
            // Institute ID is required for all roles except 'super_admin'
            return this.role !== 'super_admin';
        }
    }
}, { timestamps: true }); // Adds createdAt and updatedAt fields automatically

// --- IMPORTANT SECURITY WARNING ---
// Password Hashing is NOT implemented here as per your request.
// In a production environment, you MUST hash passwords using a library like bcryptjs.
// Example (to add later):
/*
userSchema.pre('save', async function(next) {
    if (this.isModified('password')) {
        const bcrypt = require('bcryptjs');
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
    }
    next();
});
userSchema.methods.comparePassword = async function(candidatePassword) {
    const bcrypt = require('bcryptjs');
    return await bcrypt.compare(candidatePassword, this.password);
};
*/
// --- END SECURITY WARNING ---

const User = mongoose.model('User', userSchema);
module.exports = User;