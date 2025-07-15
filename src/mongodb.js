const mongoose = require("mongoose");
// Use the MONGODB_URI environment variable for a single connection
// This URI will connect to your MongoDB Atlas cluster, and you can specify the default database name within the URI itself (e.g., /quizai_db)
mongoose.connect(process.env.MONGODB_URI)
.then(() => {
    console.log("✅ Successfully connected to MongoDB Atlas");
})
.catch((error) => {
    console.error("❌ Failed to connect to MongoDB Atlas:", error);
    // You might want to exit the process if the database connection fails on startup
    process.exit(1); 
})

// 🔄 UPDATED: Single QuizAI Database Connection
const quizAIConnection = mongoose.createConnection("mongodb://localhost:27017/QuizAI");

quizAIConnection.on('connected', () => {
    console.log("✅ Connected to QuizAI database - All collections unified with Join System!");
});

quizAIConnection.on('error', (error) => {
    console.log("❌ Failed to connect to QuizAI database:", error);
});

// ==================== EXISTING SCHEMAS ====================

// For Student
const studentSchema = new mongoose.Schema({
    // Keep 'name' for display/legacy if needed, but make it optional or derived
    // If you want to strictly use firstName/lastName, you can remove 'name' here
    // For now, let's keep it and make it optional, or set it via a pre-save hook.
    name: {
        type: String,
        required: false // Make it not required, as we'll use firstName/lastName
    },
    firstName: { // 🆕 NEW FIELD
        type: String,
        required: true, // Assuming first name is required for a student
        trim: true
    },
    lastName: { // 🆕 NEW FIELD
        type: String,
        required: false, // Last name can be optional
        trim: true
    },
    email: {
        type: String,
        unique: true,
        sparse: true, // Allows null values but enforces uniqueness for non-null
        trim: true,
        lowercase: true,
        match: [/.+@.+\..+/, 'Please fill a valid email address'] // Basic email regex validation
    },
    isVerified: {
        type: Boolean,
        default: false
    },
    pendingEmail: String, // 🆕 NEW FIELD: Stores email pending verification
    verificationToken: String,
    verificationTokenExpires: Date,
    resetPasswordToken: String, // 🆕 NEW FIELD
    resetPasswordTokenExpires: Date, // 🆕 NEW FIELD
    enrollment: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        uppercase: true
    },
    password: {
        type: String,
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

// Add a pre-save hook to update 'name' from 'firstName' and 'lastName'
studentSchema.pre('save', function (next) {
    if (this.isModified('firstName') || this.isModified('lastName') || (!this.firstName && this.name)) {
        if (!this.firstName && this.name) {
            const nameParts = this.name.split(' ').filter(part => part.trim() !== '');
            this.firstName = nameParts[0] || '';
            this.lastName = nameParts.slice(1).join(' ') || '';
        }
        this.name = `${this.firstName || ''} ${this.lastName || ''}`.trim();
    }
    this.updatedAt = Date.now();
    next();
});

// For Teacher
const teacherSchema = new mongoose.Schema({
    // Keep 'name' for display/legacy if needed, but make it optional or derived
    name: {
        type: String,
        required: false // Make it not required, as we'll use firstName/lastName
    },
    firstName: { // 🆕 NEW FIELD
        type: String,
        required: true, // Assuming first name is required for a teacher
        trim: true
    },
    lastName: { // 🆕 NEW FIELD
        type: String,
        required: false, // Last name can be optional for teachers
        trim: true
    },
    email: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true,
        match: [/.+@.+\..+/, 'Please fill a valid email address']
    },
    password: {
        type: String,
        required: true
    },
    isVerified: {
        type: Boolean,
        default: false
    },
    pendingEmail: String, // 🆕 NEW FIELD: Stores email pending verification
    verificationToken: String,
    verificationTokenExpires: Date,
    resetPasswordToken: String, // 🆕 NEW FIELD
    resetPasswordTokenExpires: Date, // 🆕 NEW FIELD
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

// Add a pre-save hook to update 'name' from 'firstName' and 'lastName'
teacherSchema.pre('save', function (next) {
    // If firstName or lastName are modified, or if they are new and name exists
    if (this.isModified('firstName') || this.isModified('lastName') || (!this.firstName && this.name)) {
        // If firstName is not set but name is, try to parse from name (for old data/signup)
        if (!this.firstName && this.name) {
            const nameParts = this.name.split(' ').filter(part => part.trim() !== '');
            this.firstName = nameParts[0] || '';
            this.lastName = nameParts.slice(1).join(' ') || '';
        }
        // Always update the 'name' field from 'firstName' and 'lastName'
        this.name = `${this.firstName || ''} ${this.lastName || ''}`.trim();
    }
    this.updatedAt = Date.now(); // Update updatedAt on every save
    next();
});

// ==================== EXISTING CLASS MANAGEMENT SCHEMAS ====================

// Classes Schema - Core class information
const classSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    subject: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        trim: true,
        default: ''
    },
    teacherId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'TeacherCollection',
        required: true
    },
    teacherName: {
        type: String,
        required: true
    },
    // 📊 Quick stats (computed fields)
    studentCount: {
        type: Number,
        default: 0
    },
    lectureCount: {
        type: Number,
        default: 0
    },
    quizCount: {
        type: Number,
        default: 0
    },
    averageScore: {
        type: Number,
        default: 0
    },
    // 🗓️ Timestamps
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    },
    isActive: {
        type: Boolean,
        default: true
    }
});

// ClassStudents Junction Table - Many-to-many relationship
const classStudentSchema = new mongoose.Schema({
    classId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ClassCollection',
        required: true
    },
    studentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'StudentCollection',
        required: true
    },
    studentName: {
        type: String,
        required: true
    },
    studentEnrollment: {
        type: String,
        required: true
    },
    enrolledAt: {
        type: Date,
        default: Date.now
    },
    isActive: {
        type: Boolean,
        default: true
    }
});

// ==================== 🆕 NEW: CLASS JOIN SYSTEM SCHEMAS ====================

// 🆕 NEW: Class Join Codes Schema - Temporary codes with 10min expiry
const classJoinCodeSchema = new mongoose.Schema({
    classId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ClassCollection',
        required: true
    },
    teacherId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'TeacherCollection',
        required: true
    },
    className: {
        type: String,
        required: true
    },
    classSubject: {
        type: String,
        required: true
    },
    teacherName: {
        type: String,
        required: true
    },
    joinCode: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        minlength: 6,
        maxlength: 6
    },
    expiresAt: {
        type: Date,
        required: true,
        index: { expireAfterSeconds: 0 } // MongoDB TTL index for automatic cleanup
    },
    isActive: {
        type: Boolean,
        default: true
    },
    generatedAt: {
        type: Date,
        default: Date.now
    },
    usageCount: {
        type: Number,
        default: 0
    },
    maxUsage: {
        type: Number,
        default: 50 // Prevent spam, reasonable limit for class size
    }
});

// 🆕 NEW: Class Join Requests Schema - Pending approval requests
const classJoinRequestSchema = new mongoose.Schema({
    classId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ClassCollection',
        required: true
    },
    studentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'StudentCollection',
        required: true
    },
    studentName: {
        type: String,
        required: true
    },
    studentEnrollment: {
        type: String,
        required: true
    },
    joinCode: {
        type: String,
        required: true,
        uppercase: true
    },
    // Class info for easier reference
    className: {
        type: String,
        required: true
    },
    classSubject: {
        type: String,
        required: true
    },
    teacherId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'TeacherCollection',
        required: true
    },
    teacherName: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending'
    },
    requestedAt: {
        type: Date,
        default: Date.now
    },
    processedAt: {
        type: Date
    },
    processedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'TeacherCollection'
    },
    rejectionReason: {
        type: String,
        trim: true
    },
    // Metadata
    ipAddress: {
        type: String
    },
    userAgent: {
        type: String
    }
});

// ==================== ENHANCED EXISTING SCHEMAS ====================

// Lectures Schema - Now supports classes
const lectureSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true
    },
    filePath: {
        type: String,
        required: false
    },
    originalFileName: String,
    mimeType: String,
    fileSize: Number,
    extractedText: {
        type: String,
        required: true
    },
    textLength: {
        type: Number,
        default: 0
    },
    uploadDate: {
        type: Date,
        default: Date.now
    },
    lastProcessed: {
        type: Date
    },
    quizGenerated: {
        type: Boolean,
        default: false
    },
    quizzesCount: {
        type: Number,
        default: 0
    },
    processingStatus: {
        type: String,
        enum: ['pending', 'processing', 'completed', 'failed'],
        default: 'pending'
    },
    quizGenerationError: {
        type: String
    },
    fileType: {
        type: String,
        required: true
    },
    professorName: {
        type: String,
        required: true
    },
    professorId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'TeacherCollection',
        required: true
    },
    // Class association
    classId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ClassCollection',
        required: false
    },
    className: {
        type: String,
        required: false
    }
});


// 🔄 ENSURE: Quiz Schema has proper duration field (your existing schema should already have this)

const quizSchema = new mongoose.Schema({
    lectureId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'LectureCollection',
        required: true
    },
    lectureTitle: {
        type: String,
        required: true
    },
    durationMinutes: {
        type: Number,
        required: true,
        default: 15,
        min: 2,
        max: 60
    },
    classId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ClassCollection',
        required: false
    },
    className: {
        type: String,
        required: false
    },
    questions: [{
        question: {
            type: String,
            required: true
        },
        options: {
            A: { type: String, required: true },
            B: { type: String, required: true },
            C: { type: String, required: true },
            D: { type: String, required: true }
        },
        correct_answer: {
            type: String,
            enum: ['A', 'B', 'C', 'D'],
            required: true
        },
        // Enhanced explanation fields

        explanations: {
            A: { type: String, default: "" },
            B: { type: String, default: "" }, 
            C: { type: String, default: "" },
            D: { type: String, default: "" }
        },
        correctAnswerExplanation: {
            type: String,
            default: ""
        }
    }],
    totalQuestions: {
        type: Number,
        required: true
    },
    generatedDate: {
        type: Date,
        default: Date.now
    },
    isActive: {
        type: Boolean,
        default: true
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'TeacherCollection',
        required: true
    },
    totalAttempts: {
        type: Number,
        default: 0
    },
    averageScore: {
        type: Number,
        default: 0
    },
    highestScore: {
        type: Number,
        default: 0
    }
});

// Quiz Results Schema with anti-cheating metadata
const quizResultSchema = new mongoose.Schema({
    quizId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'QuizCollection',
        required: true
    },
    lectureId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'LectureCollection',
        required: true
    },
    classId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ClassCollection',
        required: false
    },
    studentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'StudentCollection',
        required: true
    },
    studentName: {
        type: String,
        required: true
    },
    score: {
        type: Number,
        required: true,
        min: 0
    },
    totalQuestions: {
        type: Number,
        required: true
    },
    percentage: {
        type: Number,
        required: true,
        min: 0,
        max: 100
    },
    timeTakenSeconds: {
        type: Number,
        required: true,
        min: 0
    },
    submissionDate: {
        type: Date,
        default: Date.now
    },
    quizDurationMinutes: {
        type: Number,
        required: false,
        min: 2,
        max: 120
    },
    quizDurationSeconds: {
        type: Number,
        required: false,
        min: 120,
        max: 7200
    },
    timeEfficiency: {
        type: Number,
        required: false,
        min: 0,
        max: 100
    },
    antiCheatMetadata: {
        violationCount: {
            type: Number,
            default: 0,
            min: 0,
            max: 10
        },
        wasAutoSubmitted: {
            type: Boolean,
            default: false
        },
        gracePeriodsUsed: {
            type: Number,
            default: 0,
            min: 0
        },
        securityStatus: {
            type: String,
            enum: ['Clean', 'Warning', 'Violation', 'Auto-Submit'],
            default: 'Clean'
        },
        submissionSource: {
            type: String,
            enum: ['Manual', 'Auto-Submit', 'Timer-Submit'],
            default: 'Manual'
        },
        violationDetails: [{
            violationType: {
                type: String,
                enum: ['tab_switch', 'window_blur', 'focus_loss'],
                required: false
            },
            timestamp: {
                type: Date,
                required: false
            },
            duration: {
                type: Number,
                required: false
            }
        }],
        monitoringStartTime: {
            type: Date,
            required: false
        },
        monitoringEndTime: {
            type: Date,
            required: false
        }
    },
    answers: [{
        questionIndex: {
            type: Number,
            required: true
        },
        question: {
            type: String,
            required: true
        },
        selectedOption: {
            type: String,
            enum: ['A', 'B', 'C', 'D'],
            required: true
        },
        correctOption: {
            type: String,
            enum: ['A', 'B', 'C', 'D'],
            required: true
        },
        isCorrect: {
            type: Boolean,
            required: true
        }
    }]
});

// AI Explanations Cache Schema
const explanationCacheSchema = new mongoose.Schema({
    questionText: {
        type: String,
        required: true
    },
    correctAnswer: {
        type: String,
        required: true,
        enum: ['A', 'B', 'C', 'D']
    },
    wrongAnswer: {
        type: String,
        required: true,
        enum: ['A', 'B', 'C', 'D']
    },
    correctOption: {
        type: String,
        required: true
    },
    wrongOption: {
        type: String,
        required: true
    },
    lectureId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'LectureCollection',
        required: true
    },
    explanation: {
        type: String,
        required: true
    },
    generatedDate: {
        type: Date,
        default: Date.now
    },
    usageCount: {
        type: Number,
        default: 1
    }
});

// ==================== INDEXES FOR PERFORMANCE ====================

// Existing indexes
studentSchema.index({ enrollment: 1 });
teacherSchema.index({ email: 1 });
lectureSchema.index({ professorId: 1, uploadDate: -1 });
quizSchema.index({ lectureId: 1, generatedDate: -1 });
quizResultSchema.index({ studentId: 1, submissionDate: -1 });


// 🆕 NEW: Class management indexes
classSchema.index({ teacherId: 1, createdAt: -1 }); // Find teacher's classes
classSchema.index({ isActive: 1, teacherId: 1 }); // Active classes for teacher
classStudentSchema.index({ classId: 1, isActive: 1 }); // Students in a class
classStudentSchema.index({ studentId: 1, isActive: 1 }); // Classes for a student
classStudentSchema.index({ classId: 1, studentId: 1 }, { unique: true }); // Prevent duplicates

// Enhanced indexes for class-based queries
lectureSchema.index({ classId: 1, uploadDate: -1 });
quizSchema.index({ classId: 1, generatedDate: -1 });
quizResultSchema.index({ classId: 1, submissionDate: -1 });

// 🆕 NEW: Join System Indexes for Performance
classJoinCodeSchema.index({ joinCode: 1 }, { unique: true }); // Fast code lookup
classJoinCodeSchema.index({ classId: 1, isActive: 1 }); // Active codes for a class
classJoinCodeSchema.index({ teacherId: 1, isActive: 1 }); // Teacher's active codes
classJoinCodeSchema.index({ expiresAt: 1 }); // TTL cleanup and expiry checks
classJoinCodeSchema.index({ generatedAt: -1 }); // Recent codes first

classJoinRequestSchema.index({ classId: 1, status: 1 }); // Requests by class and status
classJoinRequestSchema.index({ studentId: 1, status: 1 }); // Student's requests
classJoinRequestSchema.index({ teacherId: 1, status: 1 }); // Teacher's pending requests
classJoinRequestSchema.index({ requestedAt: -1 }); // Recent requests first
classJoinRequestSchema.index({ joinCode: 1 }); // Track usage of codes
classJoinRequestSchema.index({ 
    studentId: 1, 
    classId: 1 
}, { 
    unique: true, 
    partialFilterExpression: { status: { $in: ['pending', 'approved'] } } 
}); // Prevent duplicate active requests

// Anti-cheat indexes
quizResultSchema.index({ 
    'antiCheatMetadata.violationCount': 1, 
    submissionDate: -1 
});
quizResultSchema.index({ 
    'antiCheatMetadata.wasAutoSubmitted': 1, 
    submissionDate: -1 
});
quizResultSchema.index({ 
    'antiCheatMetadata.securityStatus': 1, 
    classId: 1, 
    submissionDate: -1 
});

// Create compound index for fast explanation lookups

explanationCacheSchema.index({ 
    questionText: 1, 
    correctAnswer: 1, 
    wrongAnswer: 1,
    lectureId: 1 
});


// ==================== SCHEMA MIDDLEWARE ====================

// Update class stats when students are added/removed
classStudentSchema.post('save', async function() {
    try {
        const ClassCollection = this.constructor.model('ClassCollection');
        const classDoc = await ClassCollection.findById(this.classId);
        if (classDoc) {
            const activeStudents = await this.constructor.countDocuments({ 
                classId: this.classId, 
                isActive: true 
            });
            await ClassCollection.findByIdAndUpdate(this.classId, { 
                studentCount: activeStudents,
                updatedAt: new Date()
            });
        }
    } catch (error) {
        console.error('❌ Error updating class student count:', error);
    }
});

// Update class stats when lectures are added
lectureSchema.post('save', async function() {
    try {
        if (this.classId) {
            const ClassCollection = this.constructor.db.model('ClassCollection');
            const lectureCount = await this.constructor.countDocuments({ 
                classId: this.classId 
            });
            await ClassCollection.findByIdAndUpdate(this.classId, { 
                lectureCount: lectureCount,
                updatedAt: new Date()
            });
        }
    } catch (error) {
        console.error('❌ Error updating class lecture count:', error);
    }
});

// Update class and quiz stats when quizzes are added
quizSchema.post('save', async function() {
    try {
        if (this.classId) {
            const ClassCollection = this.constructor.db.model('ClassCollection');
            const quizCount = await this.constructor.countDocuments({ 
                classId: this.classId 
            });
            await ClassCollection.findByIdAndUpdate(this.classId, { 
                quizCount: quizCount,
                updatedAt: new Date()
            });
        }
    } catch (error) {
        console.error('❌ Error updating class quiz count:', error);
    }
});

// Update quiz stats when results are submitted
quizResultSchema.post('save', async function() {
    try {
        const QuizCollection = this.constructor.db.model('QuizCollection');
        const allResults = await this.constructor.find({ quizId: this.quizId });
        
        const totalAttempts = allResults.length;
        const averageScore = totalAttempts > 0 
            ? parseFloat((allResults.reduce((sum, result) => sum + result.percentage, 0) / totalAttempts).toFixed(1))
            : 0;
        const highestScore = totalAttempts > 0 
            ? parseFloat(Math.max(...allResults.map(result => result.percentage)).toFixed(1))
            : 0;
        
        await QuizCollection.findByIdAndUpdate(this.quizId, {
            totalAttempts,
            averageScore,
            highestScore
        });
        
        if (this.classId) {
            const ClassCollection = this.constructor.db.model('ClassCollection');
            const classResults = await this.constructor.find({ classId: this.classId });
            
            if (classResults.length > 0) {
                const classAverageScore = parseFloat((classResults.reduce((sum, result) => sum + result.percentage, 0) / classResults.length).toFixed(1));
                await ClassCollection.findByIdAndUpdate(this.classId, { 
                    averageScore: classAverageScore,
                    updatedAt: new Date()
                });
            }
        }
    } catch (error) {
        console.error('❌ Error updating quiz and class stats:', error);
    }
});

// 🆕 NEW: Auto-set anti-cheat metadata
quizResultSchema.pre('save', function(next) {
    try {
        if (!this.antiCheatMetadata) {
            this.antiCheatMetadata = {
                violationCount: 0,
                wasAutoSubmitted: false,
                gracePeriodsUsed: 0,
                securityStatus: 'Clean',
                submissionSource: 'Manual',
                violationDetails: [],
                monitoringStartTime: new Date(),
                monitoringEndTime: new Date()
            };
        }
        
        if (this.antiCheatMetadata.violationCount === 0) {
            this.antiCheatMetadata.securityStatus = 'Clean';
        } else if (this.antiCheatMetadata.violationCount === 1) {
            this.antiCheatMetadata.securityStatus = 'Warning';
        } else if (this.antiCheatMetadata.violationCount >= 2) {
            this.antiCheatMetadata.securityStatus = this.antiCheatMetadata.wasAutoSubmitted ? 'Auto-Submit' : 'Violation';
        }
        
        next();
    } catch (error) {
        console.error('❌ Error in quizResult pre-save middleware:', error);
        next(error);
    }
});

// 🆕 NEW: Join Code Methods
classJoinCodeSchema.methods.isExpired = function() {
    return new Date() > this.expiresAt;
};

classJoinCodeSchema.methods.canBeUsed = function() {
    return this.isActive && !this.isExpired() && this.usageCount < this.maxUsage;
};

classJoinCodeSchema.statics.generateUniqueCode = async function() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let attempts = 0;
    const maxAttempts = 10;
    
    while (attempts < maxAttempts) {
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += characters.charAt(Math.floor(Math.random() * characters.length));
        }
        
        const existing = await this.findOne({ joinCode: code, isActive: true });
        if (!existing) {
            return code;
        }
        
        attempts++;
    }
    
    throw new Error('Unable to generate unique join code after maximum attempts');
};

// 🆕 NEW: Join Request Methods
classJoinRequestSchema.methods.approve = async function(approvedBy) {
    this.status = 'approved';
    this.processedAt = new Date();
    this.processedBy = approvedBy;
    return await this.save();
};

classJoinRequestSchema.methods.reject = async function(rejectedBy, reason) {
    this.status = 'rejected';
    this.processedAt = new Date();
    this.processedBy = rejectedBy;
    this.rejectionReason = reason || 'No reason provided';
    return await this.save();
};

classJoinRequestSchema.statics.findPendingForTeacher = function(teacherId) {
    return this.find({
        teacherId: teacherId,
        status: 'pending'
    }).sort({ requestedAt: -1 });
};

// 🆕 NEW: Security summary virtual
quizResultSchema.virtual('securitySummary').get(function() {
    const metadata = this.antiCheatMetadata || {};
    return {
        isClean: metadata.violationCount === 0,
        hasViolations: metadata.violationCount > 0,
        wasCompromised: metadata.violationCount >= 2,
        submissionType: metadata.submissionSource || 'Manual',
        riskLevel: metadata.violationCount === 0 ? 'Low' : 
                  metadata.violationCount === 1 ? 'Medium' : 'High'
    };
});

// ==================== CREATE COLLECTIONS ====================

// User authentication collections
const studentCollection = mongoose.model("StudentCollection", studentSchema);
const teacherCollection = mongoose.model("TeacherCollection", teacherSchema);

// Lecture and quiz system collections
const lectureCollection = mongoose.model("LectureCollection", lectureSchema);
const quizCollection = mongoose.model("QuizCollection", quizSchema);
const quizResultCollection = mongoose.model("QuizResultCollection", quizResultSchema);
const explanationCacheCollection = mongoose.model("ExplanationCache", explanationCacheSchema);


// Class management collections
const classCollection = quizAIConnection.model("ClassCollection", classSchema);
const classStudentCollection = quizAIConnection.model("ClassStudentCollection", classStudentSchema);

// 🆕 NEW: Join System Collections
const classJoinCodeCollection = quizAIConnection.model("ClassJoinCodeCollection", classJoinCodeSchema);
const classJoinRequestCollection = quizAIConnection.model("ClassJoinRequestCollection", classJoinRequestSchema);

// ==================== EXPORT ALL COLLECTIONS ====================

module.exports = {
    // User authentication collections
    studentCollection,
    teacherCollection,
    
    // Lecture and quiz system collections
    lectureCollection,
    quizCollection,
    quizResultCollection,
    explanationCacheCollection,
    
    // Class management collections
    classCollection,
    classStudentCollection,
    
    // 🆕 NEW: Join system collections
    classJoinCodeCollection,
    classJoinRequestCollection
}
