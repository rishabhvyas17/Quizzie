// TO run the codebase

// npm i express 
// npm i hbs 
// npm i mongoose 

// npm i nodemon 
// nodemon src/index.js  // it will keep runing the file so we dont need to runit again and again

const express = require("express")
const app = express()
const path=require("path")
const hbs=require("hbs")
const {studentCollection, teacherCollection} =require("./mongodb") // added teacher and student collection

const templatePath=path.join(__dirname,'../tempelates')

app.use(express.json())
app.set("view engine", "hbs")
app.set("views", templatePath)

app.use(express.urlencoded({extended:false}))

// Root route - redirect to login
app.get("/", (req, res) => {             // when you will at / will redirect to /login
    res.redirect("/login")
})

app.get("/login",(req,res)=>{
    res.render("login")
})

app.get("/signup",(req,res)=>{
    res.render("signup")
})

app.get("/homeStudent", (req, res) => {   /// here when you will at /homeStudent then will render homeStudent
    res.render("homeStudent", {
        userType: "student",
        userName: req.query.userName || "Student"
    })
})

app.get("/homeTeacher", (req, res) => {    /// here when you will at /homeTeacher then will render hometeacher
    res.render("homeTeacher", {
        userType: "teacher", 
        userName: req.query.userName || "Teacher"
    })
})

app.post("/signup", async (req, res) => {
    try {
        const userType = req.body.userType; // 'student' or 'teacher'

        if (userType === 'teacher') { // Check the user type from the form and insert into appropriate collection
            const data = { // Create a new user object with data from the request
                name: req.body.name,
                email: req.body.email,
                password: req.body.password
            };
            await teacherCollection.insertMany([data]);

            res.redirect(`/homeTeacher?userName=${encodeURIComponent(data.name)}`);// Redirect to home page after successful registration

        } else {
            const data = { // Create a new user object with data from the requestv
                name: req.body.name,
                enrollment: req.body.enrollment,
                password: req.body.password
            };
            await studentCollection.insertMany([data]);
            
            res.redirect(`/homeStudent?userName=${encodeURIComponent(data.name)}`);// Redirect to home page after successful registration
        }

    } catch (error) {
        console.log(error);
        res.send("Error during registration");
    }
});

// Handle user login
app.post("/login", async (req, res) => {
    try {
        const { name, password, userType } = req.body;
        let user;

        // Check in appropriate collection based on user type
        if (userType === 'teacher') {
            const { email } = req.body;
            user = await teacherCollection.findOne({ email: email });
        } else {
            const { enrollment } = req.body;
            user = await studentCollection.findOne({ enrollment: enrollment });
        }
        // Check if user exists and password matches
        if (user && user.password === password) {
            if (userType === 'teacher') {
                res.redirect(`/homeTeacher?userName=${encodeURIComponent(user.name)}`)
            } else {
                res.redirect(`/homeStudent?userName=${encodeURIComponent(user.name)}`)
            }
        } else {
            res.send("Wrong credentials");
        }

    } catch (error) {
        console.log(error);
        res.send("Login failed");
    }
});

app.listen(3000,()=>{
    console.log("port-connected");    // this will connect and conform that port is connected
})