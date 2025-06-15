const mongoose = require("mongoose")

// Separate databases for different purposes
const loginDB = mongoose.createConnection("mongodb://localhost:27017/LoginSignup")
const quizDB = mongoose.createConnection("mongodb://localhost:27017/QuizAI")

// Connection event handlers for LoginSignup DB
loginDB.on('connected', () => {
    console.log("LoginSignup database connected");
})
loginDB.on('error', (err) => {
    console.log("LoginSignup database connection failed:", err);
})

// Connection event handlers for QuizAI DB
quizDB.on('connected', () => {
    console.log("QuizAI database connected");
})
quizDB.on('error', (err) => {
    console.log("QuizAI database connection failed:", err);
})

// For Student (LoginSignup DB)
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

// For Teacher (LoginSignup DB)
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

// For Lectures (QuizAI DB) - Optimized for AI processing
const lectureSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true
    },
    teacherId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'TeacherCollection',
        required: false // Made optional for now
    },
    teacherName: {
        type: String,
        required: false // Store teacher name for easier queries
    },
    originalFileName: {
        type: String,
        required: true
    },
    extractedText: {
        type: String,
        required: true
    },
    textLength: {
        type: Number,
        default: 0 // Store text length for analytics
    },
    uploadDate: {
        type: Date,
        default: Date.now
    },
    fileType: {
        type: String,
        required: true // 'pdf', 'docx', 'pptx', etc.
    },
    quizGenerated: {
        type: Boolean,
        default: false
    },
    quizzesCount: {
        type: Number,
        default: 0
    },
    lastProcessed: {
        type: Date,
        default: null
    },
    processingStatus: {
        type: String,
        enum: ['pending', 'processing', 'completed', 'failed'],
        default: 'pending'
    }
})

// For Quizzes (QuizAI DB)
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
        options: [{
            type: String,
            required: true
        }],
        correctAnswer: {
            type: Number,
            required: true,
            min: 0,
            max: 3
        },
        explanation: {
            type: String,
            default: ''
        },
        difficulty: {
            type: String,
            enum: ['easy', 'medium', 'hard'],
            default: 'medium'
        },
        topic: {
            type: String,
            default: ''
        }
    }],
    createdDate: {
        type: Date,
        default: Date.now
    },
    totalQuestions: {
        type: Number,
        default: 0
    },
    averageDifficulty: {
        type: String,
        enum: ['easy', 'medium', 'hard'],
        default: 'medium'
    },
    generatedBy: {
        type: String,
        default: 'AI' // Could be 'AI' or 'Manual'
    },
    isActive: {
        type: Boolean,
        default: true
    }
})

// Create models with their respective database connections
const studentCollection = loginDB.model("StudentCollection", studentSchema)
const teacherCollection = loginDB.model("TeacherCollection", teacherSchema)
const lectureCollection = quizDB.model("LectureCollection", lectureSchema)
const quizCollection = quizDB.model("QuizCollection", quizSchema)

// Export both connections and models
module.exports = {
    // Database connections
    loginDB,
    quizDB,
    
    // Models
    studentCollection,
    teacherCollection,
    lectureCollection,
    quizCollection


    //end
}