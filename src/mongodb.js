const mongoose = require("mongoose")

mongoose.connect("mongodb://localhost:27017/LoginSignup")
.then(()=>{
    console.log("mongodb connected");
})

.catch(()=>{
    console.log("failed to connect");
})

// For Student
const studentSchema = new mongoose.Schema({
    name:{
        type:String,
        require:true
    },
    enrollment:{
        type:String,
        require:true
    },
    password:{
        type:String,
        require:true
    }
})
// For Teacher
const teacherSchema = new mongoose.Schema({
    name:{
        type:String,
        require:true
    },
    email:{
        type:String,
        require:true
    },
    password:{
        type:String,
        require:true
    }
})

// For Lectures
const lectureSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true
    },
    filePath: { // The path where the file is stored on your server
        type: String,
        required: true
    },
    originalFileName: String,
    mimeType: String,
    fileSize: Number,
    uploadDate: {
        type: Date,
        default: Date.now
    },
    quizGenerated: { // A flag to indicate if a quiz has been generated for this lecture
        type: Boolean,
        default: false
    },
    professorName: { // To link the lecture to the professor who uploaded it
        type: String,
        required: true
    }
});


const studentCollection = new mongoose.model("StudentCollection",studentSchema ) //Collection for students

const teacherCollection = new mongoose.model("TeacherCollection",teacherSchema) // collection for teachers

const lectureCollection = new mongoose.model("LectureCollection", lectureSchema); // Collection for lectures


module.exports = {
    studentCollection,
    teacherCollection,
    lectureCollection // Export the new lectureCollection
}