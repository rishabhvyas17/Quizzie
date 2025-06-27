const mongoose = require("mongoose")

// 🔄 UPDATED: Single QuizAI Database Connection
const quizAIConnection = mongoose.createConnection("mongodb://localhost:27017/QuizAI");

quizAIConnection.on('connected', () => {
    console.log("✅ Connected to QuizAI database - All collections unified!");
});

quizAIConnection.on('error', (error) => {
    console.log("❌ Failed to connect to QuizAI database:", error);
});

// ==================== EXISTING SCHEMAS ====================

// For Student
const studentSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    enrollment: {
        type: String,
        required: true,
        unique: true
    },
    password: {
        type: String,
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
})

// For Teacher
const teacherSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    email: {
        type: String,
        required: true,
        unique: true
    },
    password: {
        type: String,
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
})

// ==================== NEW: CLASS MANAGEMENT SCHEMAS ====================

// 🆕 Classes Schema - Core class information
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

// 🆕 ClassStudents Junction Table - Many-to-many relationship
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

// ==================== ENHANCED EXISTING SCHEMAS ====================

// 🔄 UPDATED: Lectures Schema - Now supports classes
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
    // 🆕 NEW: Class association
    classId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ClassCollection',
        required: false // Optional for backward compatibility
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
    // 🆕 CRITICAL: Duration field (ensure this is exactly as shown)
    durationMinutes: {
        type: Number,
        required: true,
        default: 15,  // Default 15 minutes
        min: 2,       // Minimum 2 minutes
        max: 60       // Maximum 60 minutes
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
    // Performance stats (computed)
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

// 🔄 UPDATED: Quiz Results Schema - Now supports duration tracking
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
    // Class association
    classId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ClassCollection',
        required: false // Optional for backward compatibility
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
    // 🆕 NEW: Duration tracking fields
    quizDurationMinutes: {
        type: Number,
        required: false, // Optional for backward compatibility
        min: 2,
        max: 120
    },
    quizDurationSeconds: {
        type: Number,
        required: false, // Optional for backward compatibility
        min: 120, // 2 minutes minimum
        max: 7200 // 2 hours maximum
    },
    timeEfficiency: {
        type: Number,
        required: false, // Optional for backward compatibility
        min: 0,
        max: 100
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

// AI Explanations Cache Schema (unchanged)
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

// 🆕 NEW: Enhanced indexes for class-based queries
lectureSchema.index({ classId: 1, uploadDate: -1 }); // Class lectures
quizSchema.index({ classId: 1, generatedDate: -1 }); // Class quizzes
quizResultSchema.index({ classId: 1, submissionDate: -1 }); // Class results

// Create compound index for fast explanation lookups
explanationCacheSchema.index({ 
    questionText: 1, 
    correctAnswer: 1, 
    wrongAnswer: 1,
    lectureId: 1 
});

// ==================== SCHEMA MIDDLEWARE ====================

// 🆕 Update class stats when students are added/removed
classStudentSchema.post('save', async function() {
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
});

// 🆕 Update class stats when lectures are added
lectureSchema.post('save', async function() {
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
});

// 🆕 Update class and quiz stats when quizzes are added
quizSchema.post('save', async function() {
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
});

// 🆕 Update quiz stats when results are submitted
quizResultSchema.post('save', async function() {
    const QuizCollection = this.constructor.db.model('QuizCollection');
    const allResults = await this.constructor.find({ quizId: this.quizId });
    
    const totalAttempts = allResults.length;
    const averageScore = totalAttempts > 0 
        ? allResults.reduce((sum, result) => sum + result.percentage, 0) / totalAttempts 
        : 0;
    const highestScore = totalAttempts > 0 
        ? Math.max(...allResults.map(result => result.percentage)) 
        : 0;
    
    await QuizCollection.findByIdAndUpdate(this.quizId, {
        totalAttempts,
        averageScore,
        highestScore
    });
    
    // Update class average score
    if (this.classId) {
        const ClassCollection = this.constructor.db.model('ClassCollection');
        const classResults = await this.constructor.find({ classId: this.classId });
        
        if (classResults.length > 0) {
            const classAverageScore = classResults.reduce((sum, result) => sum + result.percentage, 0) / classResults.length;
            await ClassCollection.findByIdAndUpdate(this.classId, { 
                averageScore: classAverageScore,
                updatedAt: new Date()
            });
        }
    }
});

// ==================== CREATE COLLECTIONS ====================
// 🔄 UPDATED: All collections now in single QuizAI Database

// User authentication collections
const studentCollection = quizAIConnection.model("StudentCollection", studentSchema);
const teacherCollection = quizAIConnection.model("TeacherCollection", teacherSchema);

// Lecture and quiz system collections
const lectureCollection = quizAIConnection.model("LectureCollection", lectureSchema);
const quizCollection = quizAIConnection.model("QuizCollection", quizSchema);
const quizResultCollection = quizAIConnection.model("QuizResultCollection", quizResultSchema);
const explanationCacheCollection = quizAIConnection.model("ExplanationCache", explanationCacheSchema);

// 🆕 NEW: Class management collections
const classCollection = quizAIConnection.model("ClassCollection", classSchema);
const classStudentCollection = quizAIConnection.model("ClassStudentCollection", classStudentSchema);

// ==================== EXPORT ALL COLLECTIONS ====================
// 🎯 All collections now unified in single QuizAI Database!

module.exports = {
    // User authentication collections
    studentCollection,
    teacherCollection,
    
    // Lecture and quiz system collections
    lectureCollection,
    quizCollection,
    quizResultCollection,
    explanationCacheCollection,
    
    // 🆕 NEW: Class management collections
    classCollection,
    classStudentCollection
}