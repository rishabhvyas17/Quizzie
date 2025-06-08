// TO run the codebase

// npm i express
// npm i hbs
// npm i mongoose

// npm i nodemon
// nodemon src/index.js  // it will keep runing the file so we dont need to runit again and again

const express = require("express")
const app = express()
const path = require("path")
const hbs = require("hbs")
const { studentCollection, teacherCollection, lectureCollection } = require("./mongodb") // added teacher and student collection, ADDED lectureCollection
const multer = require("multer") // Import multer
const fs = require("fs") // Import file system module for directory creation and file deletion

const templatePath = path.join(__dirname, '../tempelates')

app.use(express.json())
app.set("view engine", "hbs")
app.set("views", templatePath)

app.use(express.urlencoded({extended:false}))

// --- Multer Configuration for File Uploads ---
// Define the upload directory
const uploadDir = path.join(__dirname, '../uploads/lectures'); // Files will be stored in ./uploads/lectures/ relative to your app's root

// Ensure the upload directory exists when the server starts
fs.mkdirSync(uploadDir, { recursive: true });
console.log(`Ensured upload directory exists: ${uploadDir}`);

// Configure Multer Disk Storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir); // Store files in the 'uploads/lectures' directory
    },
    filename: function (req, file, cb) {
        // Generate a unique filename using timestamp and a random number
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const fileExtension = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + uniqueSuffix + fileExtension);
    }
});

// Configure File Filter (Optional but Recommended for security and validation)
const fileFilter = (req, file, cb) => {
    const allowedMimes = [
        'application/pdf',
        'application/vnd.ms-powerpoint', // .ppt
        'application/vnd.openxmlformats-officedocument.presentationml.presentation' // .pptx
    ];

    if (allowedMimes.includes(file.mimetype)) {
        cb(null, true); // Accept the file
    } else {
        // Reject the file and attach an error message to the request
        req.fileError = new Error('Invalid file type. Only PDF, PPT, and PPTX files are allowed.');
        cb(null, false); // Pass false to reject the file without an error from Multer
    }
};

// Initialize Multer upload instance
const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 50 * 1024 * 1024 // Limit file size to 50MB (adjust as needed)
    }
});
// --- End Multer Configuration ---

// Serve static files from the 'uploads' directory
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));


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

app.get("/homeStudent", async (req, res) => {   /// here when you will at /homeStudent then will render homeStudent
    const userName = req.query.userName || "Student";
    // You would fetch actual student-specific data here from your database
    // For example, enrolled classes, completed quizzes, etc.
    // const student = await studentCollection.findOne({ name: userName });
    res.render("studentDashboard", { // Changed to studentDashboard as per previous discussion
        userType: "student",
        userName: userName,
        // You would pass actual dynamic data here, e.g.:
        // enrolledClasses: student.enrolledClasses.length,
        // quizzesCompleted: student.quizzes.filter(q => q.completed).length,
        // averageScore: calculateAverageScore(student.quizzes),
        // recentPerformance: student.recentQuizzes // Array of recent quiz results
    })
})

app.get("/homeTeacher", async (req, res) => {    /// here when you will at /homeTeacher then will render hometeacher
    const userName = req.query.userName || "Teacher";
    // Fetch professor's specific data, including lectures, from your database
    // Example: const teacher = await teacherCollection.findOne({ name: userName });
    let lectures = [];
    let totalLectures = 0;
    let quizzesGenerated = 0;
    let pendingLectures = 0;

    try {
        // Assuming your LectureCollection has a 'professorName' or 'professorId' field
        // to link lectures to teachers. Replace 'professorName' with the actual field.
        lectures = await lectureCollection.find({ professorName: userName }).lean(); // .lean() to get plain JS objects
        totalLectures = lectures.length;
        quizzesGenerated = lectures.filter(lec => lec.quizGenerated).length;
        pendingLectures = lectures.filter(lec => !lec.quizGenerated).length;
    } catch (error) {
        console.error("Error fetching lectures for teacher:", error);
        // Handle error gracefully, perhaps by showing an empty list or error message
    }

    res.render("homeTeacher", { 
        userType: "teacher",
        userName: userName,
        totalLectures: totalLectures,
        quizzesGenerated: quizzesGenerated,
        pendingLectures: pendingLectures,
        totalStudents: 150, // Placeholder, fetch actual data if available
        lectures: lectures, // Pass the fetched lectures to the HBS template
        // Add success/error messages for file uploads from query parameters
        successMessage: req.query.uploadSuccess ? 'Lecture uploaded successfully! Quiz generation initiated.' : null,
        errorMessage: req.query.uploadError ? (req.query.message || 'An error occurred during upload.') : null
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

// --- New Route for Lecture Upload ---
app.post("/upload_lecture", upload.single('lectureFile'), async (req, res) => {
    // `upload.single('lectureFile')` is the Multer middleware.
    // 'lectureFile' must match the `name` attribute of your <input type="file"> in the HBS form.

    // 1. Handle file type/size errors from Multer's fileFilter or limits
    if (req.fileError) {
        // Multer's fileFilter sets req.fileError if it rejects the file
        return res.status(400).redirect(`/homeTeacher?userName=${encodeURIComponent(req.body.userName || 'Teacher')}&uploadError=true&message=${encodeURIComponent(req.fileError.message)}`);
    }

    if (!req.file) {
        // This means no file was uploaded, or another Multer error occurred (e.g., file size limit)
        return res.status(400).redirect(`/homeTeacher?userName=${encodeURIComponent(req.body.userName || 'Teacher')}&uploadError=true&message=${encodeURIComponent('No file uploaded or file is too large.')}`);
    }

    // If we reach here, the file has been successfully uploaded to 'uploads/lectures/'
    const { title, userName } = req.body; // Access the text input 'title' and 'userName' from the form

    const filePath = req.file.path; // The path where Multer saved the file on your server
    const originalFileName = req.file.originalname;
    const mimeType = req.file.mimetype;
    const fileSize = req.file.size;

    try {
        // --- 2. Database Logic: Save the lecture details to your new lectureCollection ---
        // You MUST ensure 'lectureCollection' is defined in your 'mongodb.js'
        // For example, in mongodb.js:
        // const lectureSchema = new mongoose.Schema({
        //     title: { type: String, required: true },
        //     filePath: { type: String, required: true },
        //     originalFileName: String,
        //     mimeType: String,
        //     fileSize: Number,
        //     uploadDate: { type: Date, default: Date.now },
        //     quizGenerated: { type: Boolean, default: false },
        //     professorName: { type: String, required: true } // Link to the professor
        // });
        // const lectureCollection = mongoose.model('Lecture', lectureSchema);
        // module.exports = { studentCollection, teacherCollection, lectureCollection };

        const newLectureData = {
            title: title,
            filePath: filePath,
            originalFileName: originalFileName,
            mimeType: mimeType,
            fileSize: fileSize,
            uploadDate: new Date(),
            quizGenerated: false,
            professorName: userName // Associate with the logged-in professor by name for now
        };

        await lectureCollection.insertMany([newLectureData]);
        console.log('Lecture saved to DB:', newLectureData);

        // --- 3. Send a success response back to the client (browser) ---
        res.redirect(`/homeTeacher?userName=${encodeURIComponent(userName)}&uploadSuccess=true`);

    } catch (error) {
        console.error('Error saving lecture to database:', error);

        // --- 4. Error Cleanup: If database saving fails, delete the uploaded file ---
        fs.unlink(filePath, (unlinkErr) => {
            if (unlinkErr) console.error('Failed to delete uploaded file after DB error:', unlinkErr);
            else console.log('Successfully deleted uploaded file due to DB error.');
        });

        // Send an error response back to the client
        res.status(500).redirect(`/homeTeacher?userName=${encodeURIComponent(userName || 'Teacher')}&uploadError=true&message=${encodeURIComponent('Server error during lecture upload.')}`);
    }
});
// --- End New Route for Lecture Upload ---


app.listen(3000,()=>{
    console.log("port-connected");    // this will connect and conform that port is connected
})