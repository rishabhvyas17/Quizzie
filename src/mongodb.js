const mongoose = require("mongoose")

mongoose.connect("mongodb://localhost:27017/LoginSignup")
.then(()=>{
    console.log("mongodb connected");
})

.catch(()=>{
    console.log("failed to connect");
})

const LogInSchema = new mongoose.Schema({
    name:{
        type:String,
        require:true
    },
    password:{
        type:String,
        require:true
    }
})

const studentCollection = new mongoose.model("StudentCollection",LogInSchema ) //Collection for students

const teacherCollection = new mongoose.model("TeacherCollection",LogInSchema) // collection for teachers

module.exports = {
    studentCollection,
    teacherCollection
}