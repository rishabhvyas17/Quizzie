const mongoose = require("mongoose")

// Create two separate connections
const loginSignupConnection = mongoose.createConnection("mongodb://localhost:27017/LoginSignup");
const quizAIConnection = mongoose.createConnection("mongodb://localhost:27017/QuizAI");

loginSignupConnection.on('connected', () => {
    console.log("✅ Connected to LoginSignup database");
});

quizAIConnection.on('connected', () => {
    console.log("✅ Connected to QuizAI database");
});

loginSignupConnection.on('error', (error) => {
    console.log("❌ Failed to connect to LoginSignup database:", error);
});

quizAIConnection.on('error', (error) => {
    console.log("❌ Failed to connect to QuizAI database:", error);
});

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

// For Lectures
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
    }
});

// For Quizzes generated from lectures
// STEP 1: Replace your quizSchema in mongodb.js with this enhanced version

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
        // NEW: Add these explanation fields
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
    }
});

// For Quiz Results (Student attempts)
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

// Create indexes for better performance
studentSchema.index({ enrollment: 1 });
teacherSchema.index({ email: 1 });
lectureSchema.index({ professorId: 1, uploadDate: -1 });
quizSchema.index({ lectureId: 1, generatedDate: -1 });
quizResultSchema.index({ studentId: 1, submissionDate: -1 });

// Create compound index for fast explanation lookups
explanationCacheSchema.index({ 
    questionText: 1, 
    correctAnswer: 1, 
    wrongAnswer: 1,
    lectureId: 1 
});

// Create Collections - FIXED: Lectures now in QuizAI database with quizzes
const studentCollection = loginSignupConnection.model("StudentCollection", studentSchema);
const teacherCollection = loginSignupConnection.model("TeacherCollection", teacherSchema);
const lectureCollection = quizAIConnection.model("LectureCollection", lectureSchema); // MOVED TO QuizAI
const quizCollection = quizAIConnection.model("QuizCollection", quizSchema);
const quizResultCollection = quizAIConnection.model("QuizResultCollection", quizResultSchema);
const explanationCacheCollection = quizAIConnection.model("ExplanationCache", explanationCacheSchema);

module.exports = {
    studentCollection,
    teacherCollection,
    lectureCollection,
    quizCollection,
    quizResultCollection,
    explanationCacheCollection
}