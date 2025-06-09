// TO run the codebase
// Make sure you have these packages installed:
// npm i express
// npm i hbs
// npm i mongoose
// npm i multer
// npm i officeparser // REQUIRED for PPTX text extraction
//
// To run the server:
// npm i nodemon (if you want auto-reloading)
// nodemon src/index.js  // This will keep the file running and automatically restart on changes

// --- Core Module Imports ---
const express = require("express");
const app = express();
const path = require("path");
const hbs = require("hbs");
const fs = require("fs"); // File system module for directory creation and file deletion

// --- Database & File Upload Imports ---
// Ensure './mongodb.js' exports studentCollection, teacherCollection, and lectureCollection
const { studentCollection, teacherCollection, lectureCollection } = require("./mongodb");
const multer = require("multer"); // Middleware for handling file uploads

// --- Custom Utility Imports ---
// Import the text extraction utility for parsing lecture files
// This assumes 'textExtractor.js' is located in 'src/utils/' relative to index.js
const textExtractor = require('./utils/textExtractor'); 

// --- Express App Configuration ---
// Set the path to your HBS templates
const templatePath = path.join(__dirname, '../tempelates');
console.log("Resolved template path for views:", templatePath);

// Enable JSON body parsing for incoming requests
app.use(express.json());
// Set Handlebars as the view engine
app.set("view engine", "hbs");
// Set the directory where your view (HBS) files are located
app.set("views", templatePath);
// Enable URL-encoded body parsing for form submissions
app.use(express.urlencoded({ extended: false }));

// --- Multer Configuration for File Uploads ---
// Define the directory where uploaded lecture files will be stored
const uploadDir = path.join(__dirname, '../uploads/lectures');

// Ensure the upload directory exists. If it doesn't, create it recursively.
fs.mkdirSync(uploadDir, { recursive: true });
console.log(`Ensured upload directory exists: ${uploadDir}`);

// Configure Multer's disk storage settings
const storage = multer.diskStorage({
    // Define the destination folder for uploaded files
    destination: function (req, file, cb) {
        cb(null, uploadDir); // Store files in the 'uploads/lectures' directory
    },
    // Define how the uploaded file will be named
    filename: function (req, file, cb) {
        // Generate a unique filename using timestamp, a random number, and original file extension
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const fileExtension = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + uniqueSuffix + fileExtension);
    }
});

// Configure a file filter to allow only specific file types
const fileFilter = (req, file, cb) => {
    const allowedMimes = [
        'application/pdf',
        'application/vnd.ms-powerpoint', // .ppt mime type
        'application/vnd.openxmlformats-officedocument.presentationml.presentation' // .pptx mime type
    ];

    if (allowedMimes.includes(file.mimetype)) {
        cb(null, true); // Accept the file
    } else {
        // Reject the file and attach a custom error message to the request object
        req.fileError = new Error('Invalid file type. Only PDF, PPT, and PPTX files are allowed.');
        cb(null, false); // Pass false to Multer to reject the file
    }
};

// Initialize Multer with the defined storage, file filter, and file size limits
const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 50 * 1024 * 1024 // Limit file size to 50MB (adjust as needed)
    }
});
// --- End Multer Configuration ---

// Serve static files from the 'uploads' directory. This makes uploaded files accessible via URL.
// E.g., if a file is at uploads/lectures/lecture-123.pptx, it can be accessed via /uploads/lectures/lecture-123.pptx
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// --- Routes ---

// Root route: Redirects to the login page
app.get("/", (req, res) => {
    res.redirect("/login");
});

// Login page route: Renders the login form
app.get("/login", (req, res) => {
    res.render("login");
});

// Signup page route: Renders the signup form
app.get("/signup", (req, res) => {
    res.render("signup");
});

// Student home/dashboard route: Renders the student's personalized dashboard
app.get("/homeStudent", async (req, res) => {
    const userName = req.query.userName || "Student"; // Get user name from query or default
    // TODO: In a real app, fetch actual student-specific data (e.g., enrolled classes, quizzes) from DB
    res.render("studentDashboard", { // Renders the 'studentDashboard.hbs' view
        userType: "student",
        userName: userName,
        // Example: pass dynamic data here if you fetch it
        // enrolledClasses: student.classes,
    });
});

// Teacher home/dashboard route: Renders the teacher's personalized dashboard with lecture list
app.get("/homeTeacher", async (req, res) => {
    const userName = req.query.userName || "Teacher"; // Get user name from query or default
    let lectures = [];
    let totalLectures = 0;
    let quizzesGenerated = 0;
    let pendingLectures = 0;

    try {
        // Fetch all lectures associated with the current teacher from the database
        // 'professorName' in lectureCollection should match the teacher's name
        lectures = await lectureCollection.find({ professorName: userName }).lean();
        totalLectures = lectures.length;
        // Calculate statistics based on fetched lectures
        quizzesGenerated = lectures.filter(lec => lec.quizGenerated).length;
        pendingLectures = lectures.filter(lec => !lec.quizGenerated).length;
    } catch (error) {
        console.error("Error fetching lectures for teacher:", error);
        // Handle database errors gracefully on the frontend
    }

    res.render("homeTeacher", { // Renders the 'homeTeacher.hbs' view
        userType: "teacher",
        userName: userName,
        totalLectures: totalLectures,
        quizzesGenerated: quizzesGenerated,
        pendingLectures: pendingLectures,
        totalStudents: 150, // Placeholder: Replace with actual count if available
        lectures: lectures, // Pass the array of lectures to the HBS template
        // Pass success/error messages from query parameters (set after redirects)
        successMessage: req.query.uploadSuccess ? 'Lecture uploaded successfully! Quiz generation can be initiated.' : null,
        errorMessage: req.query.uploadError ? (req.query.message || 'An error occurred during upload.') : null
    });
});

// Signup form submission route
app.post("/signup", async (req, res) => {
    try {
        const userType = req.body.userType; // Determine if user is 'student' or 'teacher'

        if (userType === 'teacher') {
            const data = {
                name: req.body.name,
                email: req.body.email,
                password: req.body.password
            };
            await teacherCollection.insertMany([data]); // Insert teacher data into teacherCollection
            res.redirect(`/homeTeacher?userName=${encodeURIComponent(data.name)}`); // Redirect to teacher dashboard
        } else {
            const data = {
                name: req.body.name,
                enrollment: req.body.enrollment,
                password: req.body.password
            };
            await studentCollection.insertMany([data]); // Insert student data into studentCollection
            res.redirect(`/homeStudent?userName=${encodeURIComponent(data.name)}`); // Redirect to student dashboard
        }
    } catch (error) {
        console.error("Error during signup:", error);
        res.send("Error during registration. Please try again.");
    }
});

// Login form submission route
app.post("/login", async (req, res) => {
    try {
        const { name, password, userType } = req.body;
        let user;

        // Find user in the appropriate collection based on userType
        if (userType === 'teacher') {
            const { email } = req.body; // Teachers log in with email
            user = await teacherCollection.findOne({ email: email });
        } else {
            const { enrollment } = req.body; // Students log in with enrollment number
            user = await studentCollection.findOne({ enrollment: enrollment });
        }

        // Check if user exists and password matches
        if (user && user.password === password) {
            // Redirect to appropriate dashboard upon successful login
            if (userType === 'teacher') {
                res.redirect(`/homeTeacher?userName=${encodeURIComponent(user.name)}`);
            } else {
                res.redirect(`/homeStudent?userName=${encodeURIComponent(user.name)}`);
            }
        } else {
            res.send("Wrong credentials. Please check your username/email and password.");
        }
    } catch (error) {
        console.error("Error during login:", error);
        res.send("Login failed due to a server error.");
    }
});

// --- Lecture Upload Route ---
// Handles POST requests to upload lecture files using Multer middleware
app.post("/upload_lecture", upload.single('lectureFile'), async (req, res) => {
    // 'lectureFile' must match the 'name' attribute of your file input in the HBS form

    // 1. Handle file upload errors (e.g., invalid type, too large) caught by Multer's fileFilter or limits
    if (req.fileError) {
        // Redirect back to homeTeacher with an error message if file validation fails
        return res.status(400).redirect(`/homeTeacher?userName=${encodeURIComponent(req.body.userName || 'Teacher')}&uploadError=true&message=${encodeURIComponent(req.fileError.message)}`);
    }

    if (!req.file) {
        // If no file was uploaded despite no specific Multer error, return a generic error
        return res.status(400).redirect(`/homeTeacher?userName=${encodeURIComponent(req.body.userName || 'Teacher')}&uploadError=true&message=${encodeURIComponent('No file uploaded or file is too large.')}`);
    }

    // If we reach here, the file has been successfully uploaded to the 'uploads/lectures/' directory
    const { title, userName } = req.body; // Extract title and userName from the form body

    const filePath = req.file.path; // Absolute path where Multer saved the file
    const originalFileName = req.file.originalname;
    const mimeType = req.file.mimetype;
    const fileSize = req.file.size;

    try {
        // 2. Save lecture details to the MongoDB lectureCollection
        const newLectureData = {
            title: title,
            filePath: filePath, // Store the server path to the file
            originalFileName: originalFileName,
            mimeType: mimeType,
            fileSize: fileSize,
            uploadDate: new Date(),
            quizGenerated: false, // Initial status: quiz not yet generated
            professorName: userName // Associate the lecture with the uploading teacher
        };

        await lectureCollection.insertMany([newLectureData]);
        console.log('Lecture saved to DB:', newLectureData);

        // 3. Redirect back to the teacher dashboard with a success message
        res.redirect(`/homeTeacher?userName=${encodeURIComponent(userName)}&uploadSuccess=true`);

    } catch (error) {
        console.error('Error saving lecture to database:', error);

        // 4. If saving to DB fails, clean up by deleting the uploaded file from the server
        fs.unlink(filePath, (unlinkErr) => {
            if (unlinkErr) console.error('Failed to delete uploaded file after DB error:', unlinkErr);
            else console.log('Successfully deleted uploaded file due to DB error.');
        });

        // Redirect back to the teacher dashboard with a server error message
        res.status(500).redirect(`/homeTeacher?userName=${encodeURIComponent(userName || 'Teacher')}&uploadError=true&message=${encodeURIComponent('Server error during lecture upload.')}`);
    }
});

// --- Generate Quiz Route ---
// Handles POST requests to initiate quiz generation for a specific lecture
// *** IMPORTANT CHANGES: Now accepts lectureId as a URL parameter and responds with JSON ***
app.post('/generate_quiz/:id', async (req, res) => { // CHANGED: Added /:id to route path
    const lectureId = req.params.id; // CHANGED: Get lectureId from URL parameters
    // Note: The client-side generateQuiz function does NOT send 'userName' in the body.
    // So, `req.body.userName` would be undefined here. If userName is needed,
    // it would have to be passed via the client-side fetch body or extracted from a session.

    let extractedText = '';

    try {
        // 1. Fetch the lecture details from the database using its ID
        const lecture = await lectureCollection.findById(lectureId);

        if (!lecture) {
            // CHANGED: Respond with JSON instead of redirect
            return res.status(404).json({ success: false, message: 'Lecture not found for quiz generation.' });
        }

        // 2. Determine file type and call the appropriate text extraction utility from textExtractor.js
        if (lecture.mimeType === 'application/vnd.ms-powerpoint' ||
            lecture.mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {

            extractedText = await textExtractor.extractTextFromPptx(lecture.filePath);
            console.log(`Extracted Text from PPTX (${lecture.originalFileName}):\n`, extractedText.substring(0, Math.min(extractedText.length, 500)) + '...');
            

            // TODO: Next Step: Send 'extractedText' to your AI model here (e.g., Google's Gemini API, OpenAI)
            // TODO: Next Step: Store the generated quiz in your database, linked to this lecture
            // Example: await lectureCollection.findByIdAndUpdate(lectureId, { quizGenerated: true, quizData: generatedQuiz });

        } else if (lecture.mimeType === 'application/pdf') {
            console.log(`PDF text extraction not yet implemented for ${lecture.originalFileName}.`);
            // CHANGED: Respond with JSON for this specific error case too
            return res.status(400).json({ success: false, message: 'PDF text extraction not yet implemented.' });
        } else {
            console.warn(`Unsupported file type for text extraction: ${lecture.mimeType}.`);
            // CHANGED: Respond with JSON for unsupported file types
            return res.status(400).json({ success: false, message: 'Unsupported file type for quiz generation.' });
        }

        // 3. If extraction initiated/successful, send a success JSON response
        res.status(200).json({ success: true, message: 'Text extraction initiated. Quiz generation would happen next!' });

    } catch (error) {
        console.error('Error during quiz generation process:', error);
        // CHANGED: Send an error JSON response for server-side errors
        res.status(500).json({ success: false, message: `Server error during quiz generation: ${error.message}` });
    }
});

// --- Delete Lecture Route ---
// Handles POST requests to delete a specific lecture by its ID
app.post('/delete_lecture/:id', async (req, res) => {
    const lectureId = req.params.id; // Get lecture ID from URL parameters
    const userName = req.body.userName; // This might be undefined as client doesn't send it in body for delete,
                                        // but good to keep if you ever pass it via hidden field or session.
                                        // For now, it's not strictly used in the delete logic itself.

    try {
        // 1. Find the lecture in the database and delete it
        // Ensure you delete all associated quizzes as well if you implement them later
        const deletedLecture = await lectureCollection.findByIdAndDelete(lectureId);

        if (!deletedLecture) {
            console.warn(`Attempted to delete non-existent lecture with ID: ${lectureId}`);
            // Respond with JSON since client expects it, even for not-found
            return res.status(404).json({ success: false, message: 'Lecture not found.' });
        }

        // 2. Delete the associated file from the server's file system
        const filePath = deletedLecture.filePath;
        if (filePath && fs.existsSync(filePath)) { // Check if path exists before attempting to unlink
            fs.unlink(filePath, (err) => {
                if (err) {
                    console.error(`Failed to delete lecture file ${filePath}:`, err);
                    // Continue even if file deletion fails, as DB record is gone
                } else {
                    console.log(`Successfully deleted file: ${filePath}`);
                }
            });
        } else {
            console.warn(`Lecture file not found on disk for ID: ${lectureId}. Path: ${filePath}`);
        }

        console.log(`Lecture ${lectureId} and its associated file deleted successfully.`);
        // Respond with JSON for success
        res.status(200).json({ success: true, message: 'Lecture deleted successfully!' });

    } catch (error) {
        console.error('Error during lecture deletion process:', error);
        // Respond with JSON for server errors
        res.status(500).json({ success: false, message: `Server error during lecture deletion: ${error.message}` });
    }
});


// --- Server Start ---
// Start the Express server and listen on port 3000
app.listen(3000, () => {
    console.log("Port connected on 3000!");
});