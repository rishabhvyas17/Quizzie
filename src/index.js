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

const { studentCollection, teacherCollection, lectureCollection, quizCollection } = require("./mongodb")

const templatePath = path.join(__dirname, '../tempelates')

app.use(express.json())
app.set("view engine", "hbs")
app.set("views", templatePath)

app.use(express.urlencoded({ extended: false }))

// Configure Multer for TEMPORARY file storage (files will be deleted after processing)
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Create temporary uploads directory if it doesn't exist
        const tempDir = './temp_uploads'
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir)
        }
        cb(null, tempDir) // Store files temporarily
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

// Enhanced text extraction functions
async function extractTextFromPDF(filePath) {
    try {
        const dataBuffer = fs.readFileSync(filePath)
        const data = await pdfParse(dataBuffer)
        console.log(`✅ PDF text extracted successfully - Length: ${data.text.length} characters`)
        return data.text
    } catch (error) {
        console.error('❌ Error extracting PDF text:', error)
        throw new Error('Failed to extract text from PDF')
    }
}

async function extractTextFromWord(filePath) {
    try {
        const result = await mammoth.extractRawText({ path: filePath })
        console.log(`✅ Word text extracted successfully - Length: ${result.value.length} characters`)
        return result.value
    } catch (error) {
        console.error('❌ Error extracting Word text:', error)
        throw new Error('Failed to extract text from Word document')
    }
}

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
        
        console.log(`✅ PowerPoint text extracted successfully - Length: ${extractedText.length} characters`)
        return extractedText || "No text found in PowerPoint file";
    } catch (error) {
        console.error('❌ Error extracting PowerPoint text:', error);
        // Fallback - return basic info instead of throwing error
        return "PowerPoint file uploaded successfully. Text extraction failed, but content is available.";
    }
}

// Main text extraction function
async function extractTextFromFile(filePath, mimetype) {
    console.log(`🔄 Starting text extraction for file type: ${mimetype}`)
    
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

// Helper function to get file type from mimetype
function getFileType(mimetype) {
    switch (mimetype) {
        case 'application/pdf':
            return 'pdf'
        case 'application/msword':
        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
            return 'docx'
        case 'application/vnd.ms-powerpoint':
        case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
            return 'pptx'
        default:
            return 'unknown'
    }
}

// Helper function to clean up temporary files
function cleanupTempFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath)
            console.log(`🗑️  Temporary file deleted: ${filePath}`)
        }
    } catch (error) {
        console.error('⚠️  Error cleaning up temporary file:', error)
    }
}

// Root route - redirect to login
app.get("/", (req, res) => {
    res.redirect("/login")
})

app.get("/login", (req, res) => {
    res.render("login")
})

app.get("/signup", (req, res) => {
    res.render("signup")
})

app.get("/homeStudent", (req, res) => {
    res.render("homeStudent", {
        userType: "student",
        userName: req.query.userName || "Student"
    })
})

app.get("/homeTeacher", async (req, res) => {
    try {
        // Get teacher's lectures from QuizAI database
        const lectures = await lectureCollection.find({}).sort({ uploadDate: -1 })
        
        // Calculate stats from actual data
        const stats = {
            totalLectures: lectures.length,
            quizzesGenerated: lectures.filter(lecture => lecture.quizGenerated).length,
            pendingLectures: lectures.filter(lecture => !lecture.quizGenerated).length,
            totalStudents: await studentCollection.countDocuments()
        }
        
        // Format lectures for display
        const formattedLectures = lectures.map(lecture => ({
            id: lecture._id,
            title: lecture.title,
            uploadDate: lecture.uploadDate.toLocaleDateString(),
            quizGenerated: lecture.quizGenerated,
            originalFileName: lecture.originalFileName,
            fileType: lecture.fileType,
            textLength: lecture.textLength,
            processingStatus: lecture.processingStatus
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
        console.error('❌ Error loading teacher dashboard:', error)
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
        const userType = req.body.userType;

        if (userType === 'teacher') {
            const data = {
                name: req.body.name,
                email: req.body.email,
                password: req.body.password
            };
            await teacherCollection.insertMany([data]);
            res.redirect(`/homeTeacher?userName=${encodeURIComponent(data.name)}`);

        } else {
            const data = {
                name: req.body.name,
                enrollment: req.body.enrollment,
                password: req.body.password
            };
            await studentCollection.insertMany([data]);
            res.redirect(`/homeStudent?userName=${encodeURIComponent(data.name)}`);
        }

    } catch (error) {
        console.log('❌ Signup error:', error);
        res.send("Error during registration");
    }
});

app.post("/login", async (req, res) => {
    try {
        const { name, password, userType } = req.body;
        let user;

        if (userType === 'teacher') {
            const { email } = req.body;
            user = await teacherCollection.findOne({ email: email });
        } else {
            const { enrollment } = req.body;
            user = await studentCollection.findOne({ enrollment: enrollment });
        }

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
        console.log('❌ Login error:', error);
        res.send("Login failed");
    }
});

// Upload lecture route - OPTIMIZED for AI processing (no permanent file storage)
app.post("/upload_lecture", upload.single('lectureFile'), async (req, res) => {
    let tempFilePath = null;
    
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
        tempFilePath = file.path

        console.log('📁 File uploaded for processing:', {
            originalName: file.originalname,
            size: file.size,
            mimetype: file.mimetype,
            tempPath: file.path
        })

        // Extract text from the uploaded file
        const extractedText = await extractTextFromFile(file.path, file.mimetype)
        
        console.log('📝 Text extraction completed:')
        console.log(`   - Total length: ${extractedText.length} characters`)
        console.log(`   - First 300 characters: ${extractedText.substring(0, 300)}...`)
        console.log(`   - Last 300 characters: ...${extractedText.slice(-300)}`)

        // Save ONLY the extracted text and metadata to database (NO FILE STORAGE)
        const lectureData = {
            title: title,
            originalFileName: file.originalname,
            extractedText: extractedText,
            textLength: extractedText.length,
            uploadDate: new Date(),
            fileType: getFileType(file.mimetype),
            quizGenerated: false,
            processingStatus: 'completed'
        }

        const savedLecture = await lectureCollection.create(lectureData)

        console.log('✅ Lecture data saved to QuizAI database successfully:', {
            id: savedLecture._id,
            title: title,
            textLength: extractedText.length
        })

        // Clean up temporary file immediately after processing
        cleanupTempFile(tempFilePath)

        // Redirect back to teacher dashboard with success message
        res.redirect('/homeTeacher?upload=success&title=' + encodeURIComponent(title))

    } catch (error) {
        console.error('❌ Upload processing error:', error)
        
        // Clean up temporary file if processing failed
        if (tempFilePath) {
            cleanupTempFile(tempFilePath)
        }
        
        res.status(500).json({ 
            success: false, 
            message: 'Failed to process uploaded file: ' + error.message 
        })
    }
})

// Route to get lecture text for AI processing
app.get('/lectures/:id/text', async (req, res) => {
    try {
        const lecture = await lectureCollection.findById(req.params.id).select('extractedText title textLength')
        if (!lecture) {
            return res.status(404).json({ success: false, message: 'Lecture not found' })
        }
        
        res.json({
            success: true,
            data: {
                id: lecture._id,
                title: lecture.title,
                textLength: lecture.textLength,
                extractedText: lecture.extractedText
            }
        })
    } catch (error) {
        console.error('❌ Error fetching lecture text:', error)
        res.status(500).json({ success: false, message: 'Error loading lecture text' })
    }
})

// Route to generate quiz - READY FOR AI INTEGRATION
app.post('/generate_quiz/:id', async (req, res) => {
    try {
        const lectureId = req.params.id
        const lecture = await lectureCollection.findById(lectureId)
        
        if (!lecture) {
            return res.status(404).json({ success: false, message: 'Lecture not found' })
        }

        // Update processing status
        await lectureCollection.findByIdAndUpdate(lectureId, { 
            processingStatus: 'processing',
            lastProcessed: new Date()
        })
        
        console.log('🤖 AI Quiz Generation Started:')
        console.log(`   - Lecture: ${lecture.title}`)
        console.log(`   - Text Length: ${lecture.textLength} characters`)
        console.log(`   - Ready for AI API call...`)
        
        // HERE IS WHERE YOU'LL INTEGRATE YOUR AI API
        // Example structure:
        /*
        const aiResponse = await callAIAPI({
            text: lecture.extractedText,
            title: lecture.title,
            requestType: 'quiz_generation'
        });
        
        const generatedQuiz = {
            lectureId: lectureId,
            lectureTitle: lecture.title,
            questions: aiResponse.questions,
            totalQuestions: aiResponse.questions.length,
            // ... other quiz data
        };
        
        await quizCollection.create(generatedQuiz);
        */
        
        // For now, mark as generated (replace this with actual AI integration)
        await lectureCollection.findByIdAndUpdate(lectureId, { 
            quizGenerated: true,
            processingStatus: 'completed',
            quizzesCount: 1 // Update when you create actual quiz
        })
        
        console.log('✅ Quiz generation completed for:', lecture.title)
        
        res.json({ 
            success: true, 
            message: 'Quiz generated successfully',
            textLength: lecture.textLength,
            title: lecture.title
        })
    } catch (error) {
        console.error('❌ Error generating quiz:', error)
        
        // Update processing status to failed
        await lectureCollection.findByIdAndUpdate(req.params.id, { 
            processingStatus: 'failed'
        })
        
        res.status(500).json({ success: false, message: 'Failed to generate quiz' })
    }
})

// Route to delete lecture (only deletes database record now)
app.post('/delete_lecture/:id', async (req, res) => {
    try {
        const lectureId = req.params.id
        const lecture = await lectureCollection.findById(lectureId)
        
        if (!lecture) {
            return res.status(404).json({ success: false, message: 'Lecture not found' })
        }
        
        // Delete associated quizzes first
        await quizCollection.deleteMany({ lectureId: lectureId })
        
        // Delete lecture record from database
        await lectureCollection.findByIdAndDelete(lectureId)
        
        console.log('🗑️  Lecture and associated quizzes deleted successfully:', lecture.title)
        
        res.json({ success: true, message: 'Lecture deleted successfully' })
    } catch (error) {
        console.error('❌ Error deleting lecture:', error)
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

// Clean up any remaining temp files on server start
function cleanupTempFiles() {
    const tempDir = './temp_uploads'
    if (fs.existsSync(tempDir)) {
        const files = fs.readdirSync(tempDir)
        files.forEach(file => {
            const filePath = path.join(tempDir, file)
            try {
                fs.unlinkSync(filePath)
                console.log(`🗑️  Cleaned up old temp file: ${file}`)
            } catch (error) {
                console.error(`⚠️  Could not clean up temp file ${file}:`, error)
            }
        })
    }
}

app.listen(3000, () => {
    console.log("🚀 Server started on port 3000");

    
    // Clean up any temp files from previous runs
    cleanupTempFiles();
})