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

app.get("/login",(req,res)=>{
    res.render("login")
})

app.get("/signup",(req,res)=>{
    res.render("signup")
})

app.post("/signup", async (req, res) => {
    try {
        // Create a new user object with data from the request
        const data = {
            name: req.body.name,
            password: req.body.password
        }

        // Check the user type from the form and insert into appropriate collection
        const userType = req.body.userType; // 'student' or 'teacher'
        
        if (userType === 'teacher') {
            await teacherCollection.insertMany([data])
        } else {
            await studentCollection.insertMany([data])
        }

        // Redirect to home page after successful registration
        res.render("home", { userType: userType })
    } catch (error) {
        console.log(error)
        res.send("Error during registration")
    }
})

// app.get("/", (req, res) => {
//     res.render("home");
// });

// Handle user login
app.post("/login", async (req, res) => {
    try {
        const { name, password, userType } = req.body;
        let user;

        // Check in appropriate collection based on user type
        if (userType === 'teacher') {
            user = await teacherCollection.findOne({ name: name })
        } else {
            user = await studentCollection.findOne({ name: name })
        }

        // Check if user exists and password matches
        if (user && user.password === password) {
            res.render("home", { 
                userType: userType,
                userName: user.name 
            })
        } else {
            res.send("Wrong credentials")
        }
    } catch (error) {
        console.log(error)
        res.send("Login failed")
    }
})


app.listen(3000,()=>{
    console.log("port-connected");    // this will connect and conform that port is connected
})
