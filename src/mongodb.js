const mongoose = require("mongoose")

mongoose.connect("mongodb://localhost:27017/LoginSignup")
.then(() => {
    console.log("mongodb connected");
})
.catch(() => {
    console.log("failed to connect");
})

// For Student
const studentSchema = new mongoose.Schema({
    name: {
        type: String,
        require: true
    },
    enrollment: {
        type: String,
        require: true
    },
    password: {
        type: String,
        require: true
    }
})

// For Teacher
const teacherSchema = new mongoose.Schema({
    name: {
        type: String,
        require: true
    },
    email: {
        type: String,
        require: true
    },
    password: {
        type: String,
        require: true
    }
})

// For Lectures
const lectureSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true
    },
    teacherId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'TeacherCollection',
        required: false // Made optional for now, you can make it required later
    },
    filename: {
        type: String,
        required: true
    },
    originalName: {
        type: String,
        required: true
    },
    filePath: {
        type: String,
        required: true
    },
    extractedText: {
        type: String,
        required: true
    },
    uploadDate: {
        type: Date,
        default: Date.now
    },
    fileSize: {
        type: Number,
        required: true
    },
    mimeType: {
        type: String,
        required: true
    },
    quizGenerated: {
        type: Boolean,
        default: false
    },
    quizzes: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'QuizCollection'
    }]
})

// For Quizzes (for future use)
const quizSchema = new mongoose.Schema({
    lectureId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'LectureCollection',
        required: true
    },
    questions: [{
        question: String,
        options: [String],
        correctAnswer: Number,
        explanation: String
    }],
    createdDate: {
        type: Date,
        default: Date.now
    },
    difficulty: {
        type: String,
        enum: ['easy', 'medium', 'hard'],
        default: 'medium'
    }
})

const studentCollection = new mongoose.model("StudentCollection", studentSchema) //Collection for students
const teacherCollection = new mongoose.model("TeacherCollection", teacherSchema) // collection for teachers
const lectureCollection = new mongoose.model("LectureCollection", lectureSchema) // collection for lectures
const quizCollection = new mongoose.model("QuizCollection", quizSchema) // collection for quizzes

module.exports = {
    studentCollection,
    teacherCollection,
    lectureCollection,
    quizCollection
}