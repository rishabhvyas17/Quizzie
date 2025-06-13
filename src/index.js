// TO run the codebase

// npm i express 
// npm i hbs 
// npm i mongoose 
// npm install multer
// npm install pdf-parse
// npm install mammoth
// npm install pptx2json

// npm i nodemon 
// nodemon src/index.js  // it will keep runing the file so we dont need to runit again and again

const express = require("express")
const app = express()
const path = require("path")
const hbs = require("hbs")
const multer = require("multer")
const fs = require("fs")
const pdfParse = require("pdf-parse")
const mammoth = require("mammoth")
const pptx2json = require("pptx2json")

const { studentCollection, teacherCollection, lectureCollection } = require("./mongodb") // added teacher and student collection

const templatePath = path.join(__dirname, '../tempelates')

app.use(express.json())
app.set("view engine", "hbs")
app.set("views", templatePath)

app.use(express.urlencoded({ extended: false }))

// Configure Multer for file storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Create uploads directory if it doesn't exist
        const uploadDir = './uploads'
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir)
        }
        cb(null, uploadDir) // Store files in 'uploads' folder
    },
    filename: function (req, file, cb) {
        // Generate unique filename: timestamp + original name
        const uniqueName = Date.now() + '-' + file.originalname
        cb(null, uniqueName)
    }
})

// File filter to accept only specific file types
const fileFilter = (req, file, cb) => {
    const allowedTypes = [
        'application/pdf',
        'application/vnd.ms-powerpoint', // .ppt
        'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
        'application/msword', // .doc
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' // .docx
    ]
    
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true) // Accept file
    } else {
        cb(new Error('Invalid file type. Only PDF, PPT, PPTX, DOC, DOCX allowed.'), false)
    }
}

// Configure multer with options
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    },
    fileFilter: fileFilter
})

// Text extraction functions
async function extractTextFromPDF(filePath) {
    try {
        const dataBuffer = fs.readFileSync(filePath)
        const data = await pdfParse(dataBuffer)
        return data.text
    } catch (error) {
        console.error('Error extracting PDF text:', error)
        throw new Error('Failed to extract text from PDF')
    }
}

async function extractTextFromWord(filePath) {
    try {
        const result = await mammoth.extractRawText({ path: filePath })
        return result.value
    } catch (error) {
        console.error('Error extracting Word text:', error)
        throw new Error('Failed to extract text from Word document')
    }
}

// Updated PowerPoint text extraction function
async function extractTextFromPowerPoint(filePath) {
    try {
        const data = await pptx2json.toJson(filePath);
        let extractedText = '';
        
        // Extract text from each slide
        if (data && data.slides) {
            data.slides.forEach((slide, index) => {
                extractedText += `\n--- Slide ${index + 1} ---\n`;
                
                if (slide.content) {
                    slide.content.forEach(content => {
                        if (content.text) {
                            extractedText += content.text + '\n';
                        }
                    });
                }
            });
        }
        
        return extractedText || "No text found in PowerPoint file";
    } catch (error) {
        console.error('Error extracting PowerPoint text:', error);
        // Fallback - return basic info instead of throwing error
        return "PowerPoint file uploaded successfully. Text extraction failed, but file is stored.";
    }
}

// Main text extraction function
async function extractTextFromFile(filePath, mimetype) {
    switch (mimetype) {
        case 'application/pdf':
            return await extractTextFromPDF(filePath)
        
        case 'application/msword':
        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
            return await extractTextFromWord(filePath)
        
        case 'application/vnd.ms-powerpoint':
        case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
            return await extractTextFromPowerPoint(filePath)
        
        default:
            throw new Error('Unsupported file type')
    }
}

// Root route - redirect to login
app.get("/", (req, res) => {             // when you will at / will redirect to /login
    res.redirect("/login")
})

app.get("/login", (req, res) => {
    res.render("login")
})

app.get("/signup", (req, res) => {
    res.render("signup")
})

app.get("/homeStudent", (req, res) => {   /// here when you will at /homeStudent then will render homeStudent
    res.render("homeStudent", {
        userType: "student",
        userName: req.query.userName || "Student"
    })
})

app.get("/homeTeacher", async (req, res) => {    /// here when you will at /homeTeacher then will render hometeacher
    try {
        // Get teacher's lectures from database
        const lectures = await lectureCollection.find({}).sort({ uploadDate: -1 })
        
        // Create mock data for stats (you can calculate these from actual data)
        const stats = {
            totalLectures: lectures.length,
            quizzesGenerated: lectures.filter(lecture => lecture.quizGenerated).length,
            pendingLectures: lectures.filter(lecture => !lecture.quizGenerated).length,
            totalStudents: await studentCollection.countDocuments() // Count all students for now
        }
        
        // Format lectures for display
        const formattedLectures = lectures.map(lecture => ({
            id: lecture._id,
            title: lecture.title,
            uploadDate: lecture.uploadDate.toLocaleDateString(),
            quizGenerated: lecture.quizGenerated,
            filename: lecture.filename,
            originalName: lecture.originalName
        }))

        res.render("homeTeacher", {
            userType: "teacher", 
            userName: req.query.userName || "Teacher",
            totalLectures: stats.totalLectures,
            quizzesGenerated: stats.quizzesGenerated,
            pendingLectures: stats.pendingLectures,
            totalStudents: stats.totalStudents,
            lectures: formattedLectures
        })
    } catch (error) {
        console.error('Error loading teacher dashboard:', error)
        res.render("homeTeacher", {
            userType: "teacher", 
            userName: req.query.userName || "Teacher",
            totalLectures: 0,
            quizzesGenerated: 0,
            pendingLectures: 0,
            totalStudents: 0,
            lectures: []
        })
    }
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

// Upload lecture route
app.post("/upload_lecture", upload.single('lectureFile'), async (req, res) => {
    try {
        // Check if file was uploaded
        if (!req.file) {
            return res.status(400).json({ 
                success: false, 
                message: 'No file uploaded' 
            })
        }

        const { title } = req.body
        const file = req.file

        console.log('File uploaded:', {
            originalName: file.originalname,
            filename: file.filename,
            size: file.size,
            mimetype: file.mimetype,
            path: file.path
        })

        // Extract text from the uploaded file
        const extractedText = await extractTextFromFile(file.path, file.mimetype)
        
        console.log('Extracted text length:', extractedText.length)
        console.log('First 200 characters:', extractedText.substring(0, 200))

        // Save the lecture info to database
        const lectureData = {
            title: title,
            filename: file.filename,
            originalName: file.originalname,
            filePath: file.path,
            uploadDate: new Date(),
            extractedText: extractedText,
            fileSize: file.size,
            mimeType: file.mimetype,
            quizGenerated: false
        }

        await lectureCollection.insertMany([lectureData])

        console.log('Lecture saved to database successfully:', title)

        // Redirect back to teacher dashboard with success message
        res.redirect('/homeTeacher?upload=success&title=' + encodeURIComponent(title))

    } catch (error) {
        console.error('Upload error:', error)
        
        // Clean up uploaded file if processing failed
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path)
        }
        
        res.status(500).json({ 
            success: false, 
            message: 'Failed to process uploaded file: ' + error.message 
        })
    }
})

// Route to serve uploaded files (for viewing)
app.get('/uploads/:filename', (req, res) => {
    const filename = req.params.filename
    const filePath = path.join(__dirname, '../uploads', filename)
    
    if (fs.existsSync(filePath)) {
        res.sendFile(path.resolve(filePath))
    } else {
        res.status(404).send('File not found')
    }
})

// Route to view lecture content
app.get('/lectures/:id/view', async (req, res) => {
    try {
        const lecture = await lectureCollection.findById(req.params.id)
        if (!lecture) {
            return res.status(404).send('Lecture not found')
        }
        
        // Serve the actual file
        if (fs.existsSync(lecture.filePath)) {
            res.sendFile(path.resolve(lecture.filePath))
        } else {
            res.status(404).send('Lecture file not found')
        }
    } catch (error) {
        console.error('Error viewing lecture:', error)
        res.status(500).send('Error loading lecture')
    }
})

// Route to generate quiz (placeholder for now)
app.post('/generate_quiz/:id', async (req, res) => {
    try {
        const lectureId = req.params.id
        const lecture = await lectureCollection.findById(lectureId)
        
        if (!lecture) {
            return res.status(404).json({ success: false, message: 'Lecture not found' })
        }
        
        // Here you would implement AI quiz generation using the extractedText
        // For now, we'll just mark it as generated
        await lectureCollection.findByIdAndUpdate(lectureId, { quizGenerated: true })
        
        console.log('Quiz generation completed for lecture:', lecture.title)
        console.log('Extracted text available for AI:', lecture.extractedText.substring(0, 100) + '...')
        
        res.json({ success: true, message: 'Quiz generated successfully' })
    } catch (error) {
        console.error('Error generating quiz:', error)
        res.status(500).json({ success: false, message: 'Failed to generate quiz' })
    }
})

// Route to delete lecture
app.post('/delete_lecture/:id', async (req, res) => {
    try {
        const lectureId = req.params.id
        const lecture = await lectureCollection.findById(lectureId)
        
        if (!lecture) {
            return res.status(404).json({ success: false, message: 'Lecture not found' })
        }
        
        // Delete the physical file
        if (fs.existsSync(lecture.filePath)) {
            fs.unlinkSync(lecture.filePath)
        }
        
        // Delete from database
        await lectureCollection.findByIdAndDelete(lectureId)
        
        console.log('Lecture deleted successfully:', lecture.title)
        
        res.json({ success: true, message: 'Lecture deleted successfully' })
    } catch (error) {
        console.error('Error deleting lecture:', error)
        res.status(500).json({ success: false, message: 'Failed to delete lecture' })
    }
})

// Logout route
app.get('/logout', (req, res) => {
    res.redirect('/login')
})

// Error handling middleware for multer
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                message: 'File too large. Maximum size is 10MB.'
            })
        }
        return res.status(400).json({
            success: false,
            message: 'File upload error: ' + error.message
        })
    }
    
    if (error.message.includes('Invalid file type')) {
        return res.status(400).json({
            success: false,
            message: error.message
        })
    }
    
    next(error)
})

app.listen(3000, () => {
    console.log("port-connected");    // this will connect and conform that port is connected
})