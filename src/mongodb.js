// mongodb.js - FIXED VERSION with resolved validation and index issues

const mongoose = require("mongoose");
// Use the MONGODB_URI environment variable for a single connection
mongoose.connect(process.env.MONGODB_URI)
.then(() => {
    console.log("✅ Successfully connected to MongoDB Atlas");
})
.catch((error) => {
    console.error("❌ Failed to connect to MongoDB Atlas:", error);
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

// ==================== FIXED SCHEMAS ====================

// For Student - FIXED validation issues
const studentSchema = new mongoose.Schema({
    name: {
        type: String,
        required: false // Not required as it will be auto-generated from firstName/lastName
    },
    firstName: {
        type: String,
        required: true, // Required for proper name handling
        trim: true
    },
    lastName: {
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
        match: [/.+@.+\..+/, 'Please fill a valid email address']
    },
    isVerified: {
        type: Boolean,
        default: false
    },
    pendingEmail: String,
    verificationToken: String,
    verificationTokenExpires: Date,
    resetPasswordToken: String,
    resetPasswordTokenExpires: Date,
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

// Pre-save hook to manage name fields for students
studentSchema.pre('save', function (next) {
    // Always ensure name is set from firstName and lastName
    this.name = `${this.firstName || ''} ${this.lastName || ''}`.trim();
    this.updatedAt = Date.now();
    next();
});

// For Teacher - FIXED validation issues
const teacherSchema = new mongoose.Schema({
    name: {
        type: String,
        required: false // Not required as it will be auto-generated from firstName/lastName
    },
    firstName: {
        type: String,
        required: true, // Required for proper name handling
        trim: true
    },
    lastName: {
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
    pendingEmail: String,
    verificationToken: String,
    verificationTokenExpires: Date,
    resetPasswordToken: String,
    resetPasswordTokenExpires: Date,
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

// Pre-save hook to manage name fields for teachers
teacherSchema.pre('save', function (next) {
    // Always ensure name is set from firstName and lastName
    this.name = `${this.firstName || ''} ${this.lastName || ''}`.trim();
    this.updatedAt = Date.now();
    next();
});

// ==================== CLASS MANAGEMENT SCHEMAS ====================

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

// ClassStudents Junction Table
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

// Class Join Codes Schema
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
        index: { expireAfterSeconds: 0 }
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
        default: 50
    }
});

// Class Join Requests Schema
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
    ipAddress: {
        type: String
    },
    userAgent: {
        type: String
    }
});

// ==================== EXISTING SCHEMAS - KEPT AS IS ====================

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
    examSessionMode: {
        type: Boolean,
        default: false
    },
    examSessionDuration: {
        type: Number,
        required: false,
        min: 5,
        max: 180
    },
    examSessionStartTime: {
        type: Date,
        required: false
    },
    examSessionEndTime: {
        type: Date,
        required: false
    },
    examSessionActive: {
        type: Boolean,
        default: false
    },
    examSessionCreatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'TeacherCollection',
        required: false
    },
    examSessionParticipants: [{
        studentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'StudentCollection'
        },
        studentName: String,
        joinedAt: {
            type: Date,
            default: Date.now
        },
        hasSubmitted: {
            type: Boolean,
            default: false
        },
        submittedAt: Date,
        autoSubmitted: {
            type: Boolean,
            default: false
        }
    }],
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
    examSessionData: {
        wasExamSession: {
            type: Boolean,
            default: false
        },
        sessionStartTime: Date,
        sessionEndTime: Date,
        sessionDurationMinutes: Number,
        joinedSessionAt: Date,
        autoSubmittedBySession: {
            type: Boolean,
            default: false
        },
        sessionTimeRemaining: Number,
        sessionParticipantCount: Number
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
            enum: ['Manual', 'Auto-Submit', 'Timer-Submit', 'Session-Auto-Submit'],
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

// ==================== FIXED INDEXES - No Duplicates ====================

// Basic indexes only (removed duplicates)
lectureSchema.index({ professorId: 1, uploadDate: -1 });
lectureSchema.index({ classId: 1, uploadDate: -1 });

quizSchema.index({ lectureId: 1, generatedDate: -1 });
quizSchema.index({ classId: 1, generatedDate: -1 });
quizSchema.index({ examSessionActive: 1 });
quizSchema.index({ examSessionEndTime: 1 });
quizSchema.index({ classId: 1, examSessionActive: 1 });

quizResultSchema.index({ studentId: 1, submissionDate: -1 });
quizResultSchema.index({ classId: 1, submissionDate: -1 });
quizResultSchema.index({ 'examSessionData.wasExamSession': 1, submissionDate: -1 });
quizResultSchema.index({ 'antiCheatMetadata.violationCount': 1, submissionDate: -1 });

classSchema.index({ teacherId: 1, createdAt: -1 });
classSchema.index({ isActive: 1, teacherId: 1 });

classStudentSchema.index({ classId: 1, isActive: 1 });
classStudentSchema.index({ studentId: 1, isActive: 1 });
classStudentSchema.index({ classId: 1, studentId: 1 }, { unique: true });

classJoinRequestSchema.index({ classId: 1, status: 1 });
classJoinRequestSchema.index({ studentId: 1, status: 1 });
classJoinRequestSchema.index({ teacherId: 1, status: 1 });
classJoinRequestSchema.index({ requestedAt: -1 });
classJoinRequestSchema.index({ 
    studentId: 1, 
    classId: 1 
}, { 
    unique: true, 
    partialFilterExpression: { status: { $in: ['pending', 'approved'] } } 
});

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

// Auto-set anti-cheat metadata
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

// ==================== SCHEMA METHODS ====================

// Quiz session methods
quizSchema.methods.startExamSession = async function(durationMinutes, startedBy) {
    this.examSessionMode = true;
    this.examSessionDuration = durationMinutes;
    this.examSessionStartTime = new Date();
    this.examSessionEndTime = new Date(Date.now() + durationMinutes * 60 * 1000);
    this.examSessionActive = true;
    this.examSessionCreatedBy = startedBy;
    this.examSessionParticipants = [];
    return await this.save();
};

quizSchema.methods.addSessionParticipant = async function(studentId, studentName) {
    const existingParticipant = this.examSessionParticipants.find(
        p => p.studentId.toString() === studentId.toString()
    );
    
    if (!existingParticipant) {
        this.examSessionParticipants.push({
            studentId,
            studentName,
            joinedAt: new Date(),
            hasSubmitted: false
        });
        return await this.save();
    }
    return this;
};

quizSchema.methods.markParticipantSubmitted = async function(studentId, autoSubmitted = false) {
    const participant = this.examSessionParticipants.find(
        p => p.studentId.toString() === studentId.toString()
    );
    
    if (participant) {
        participant.hasSubmitted = true;
        participant.submittedAt = new Date();
        participant.autoSubmitted = autoSubmitted;
        return await this.save();
    }
    return this;
};

quizSchema.methods.endExamSession = async function() {
    this.examSessionActive = false;
    return await this.save();
};

quizSchema.methods.getSessionTimeRemaining = function() {
    if (!this.examSessionActive || !this.examSessionEndTime) {
        return 0;
    }
    const now = new Date();
    const remaining = Math.max(0, this.examSessionEndTime - now);
    return Math.floor(remaining / 1000);
};

quizSchema.methods.isSessionExpired = function() {
    if (!this.examSessionActive || !this.examSessionEndTime) {
        return false;
    }
    return new Date() > this.examSessionEndTime;
};

// Join code methods
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

// Join request methods
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

// Security summary virtual
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

// Join system collections
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
    
    // Join system collections
    classJoinCodeCollection,
    classJoinRequestCollection
}