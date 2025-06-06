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

const studentCollection = new mongoose.model("StudentCollection",studentSchema ) //Collection for students

const teacherCollection = new mongoose.model("TeacherCollection",teacherSchema) // collection for teachers

module.exports = {
    studentCollection,
    teacherCollection
}