// QuizAI Server - Express.js Application
// Dependencies to install:
// npm i express hbs mongoose multer pdf-parse mammoth pptx2json @google/generative-ai dotenv nodemon
// Run with: nodemon src/index.js

const express = require("express")
const app = express()
const path = require("path")
const hbs = require("hbs")
const multer = require("multer")
const fs = require("fs")
const pdfParse = require("pdf-parse")
const mammoth = require("mammoth")
const pptx2json = require("pptx2json")

// Import database collections
const { studentCollection, teacherCollection, lectureCollection, quizCollection } = require("./mongodb")

// Configuration
const PORT = 3000
const TEMP_UPLOAD_DIR = './temp_uploads'
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
const templatePath = path.join(__dirname, '../tempelates')

// Express configuration
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.set("view engine", "hbs")
app.set("views", templatePath)

// ==================== FILE UPLOAD CONFIGURATION ====================

// Configure multer for temporary file storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        if (!fs.existsSync(TEMP_UPLOAD_DIR)) {
            fs.mkdirSync(TEMP_UPLOAD_DIR)
        }
        cb(null, TEMP_UPLOAD_DIR)
    },
    filename: function (req, file, cb) {
        const uniqueName = Date.now() + '-' + file.originalname
        cb(null, uniqueName)
    }
})

// File type validation
const fileFilter = (req, file, cb) => {
    const allowedTypes = [
        'application/pdf',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]
    
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true)
    } else {
        cb(new Error('Invalid file type. Only PDF, PPT, PPTX, DOC, DOCX allowed.'), false)
    }
}

// Multer configuration
const upload = multer({
    storage: storage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: fileFilter
})

// ==================== TEXT EXTRACTION FUNCTIONS ====================

/**
 * Extract text from PDF files
 * @param {string} filePath - Path to the PDF file
 * @returns {Promise<string>} - Extracted text content
 */
async function extractTextFromPDF(filePath) {
    try {
        const dataBuffer = fs.readFileSync(filePath)
        const data = await pdfParse(dataBuffer)
        console.log(`✅ PDF text extracted - Length: ${data.text.length} characters`)
        return data.text
    } catch (error) {
        console.error('❌ PDF extraction error:', error)
        throw new Error('Failed to extract text from PDF')
    }
}

/**
 * Extract text from Word documents (.doc, .docx)
 * @param {string} filePath - Path to the Word document
 * @returns {Promise<string>} - Extracted text content
 */
async function extractTextFromWord(filePath) {
    try {
        const result = await mammoth.extractRawText({ path: filePath })
        console.log(`✅ Word text extracted - Length: ${result.value.length} characters`)
        return result.value
    } catch (error) {
        console.error('❌ Word extraction error:', error)
        throw new Error('Failed to extract text from Word document')
    }
}

/**
 * Extract text from PowerPoint presentations (.ppt, .pptx)
 * @param {string} filePath - Path to the PowerPoint file
 * @returns {Promise<string>} - Extracted text content
 */
async function extractTextFromPowerPoint(filePath) {
    try {
        const data = await pptx2json.toJson(filePath)
        let extractedText = ''
        
        if (data && data.slides) {
            data.slides.forEach((slide, index) => {
                extractedText += `\n--- Slide ${index + 1} ---\n`
                
                if (slide.content) {
                    slide.content.forEach(content => {
                        if (content.text) {
                            extractedText += content.text + '\n'
                        }
                    })
                }
            })
        }
        
        console.log(`✅ PowerPoint text extracted - Length: ${extractedText.length} characters`)
        return extractedText || "No text found in PowerPoint file"
    } catch (error) {
        console.error('❌ PowerPoint extraction error:', error)
        return "PowerPoint file uploaded successfully. Text extraction failed, but content is available."
    }
}

/**
 * Main text extraction function - routes to appropriate extractor
 * @param {string} filePath - Path to the file
 * @param {string} mimetype - MIME type of the file
 * @returns {Promise<string>} - Extracted text content
 */
async function extractTextFromFile(filePath, mimetype) {
    console.log(`🔄 Starting text extraction for: ${mimetype}`)
    
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

// ==================== UTILITY FUNCTIONS ====================

/**
 * Get file type string from MIME type
 * @param {string} mimetype - MIME type
 * @returns {string} - File type string
 */
function getFileType(mimetype) {
    const typeMap = {
        'application/pdf': 'pdf',
        'application/msword': 'docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.ms-powerpoint': 'pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
    }
    return typeMap[mimetype] || 'unknown'
}

/**
 * Clean up temporary files after processing
 * @param {string} filePath - Path to the temporary file
 */
function cleanupTempFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath)
            console.log(`🗑️ Temporary file deleted: ${filePath}`)
        }
    } catch (error) {
        console.error('⚠️ Error cleaning up temporary file:', error)
    }
}

/**
 * Clean up all temporary files in the temp directory
 */
function cleanupTempFiles() {
    if (fs.existsSync(TEMP_UPLOAD_DIR)) {
        const files = fs.readdirSync(TEMP_UPLOAD_DIR)
        files.forEach(file => {
            const filePath = path.join(TEMP_UPLOAD_DIR, file)
            try {
                fs.unlinkSync(filePath)
                console.log(`🗑️ Cleaned up old temp file: ${file}`)
            } catch (error) {
                console.error(`⚠️ Could not clean up temp file ${file}:`, error)
            }
        })
    }
}

// ==================== AUTHENTICATION ROUTES ====================

// Root route - redirect to login
app.get("/", (req, res) => {
    res.redirect("/login")
})

// Render login page
app.get("/login", (req, res) => {
    res.render("login")
})

// Render signup page
app.get("/signup", (req, res) => {
    res.render("signup")
})

// Handle user registration
app.post("/signup", async (req, res) => {
    try {
        const { userType, name, email, enrollment, password } = req.body

        if (userType === 'teacher') {
            const teacherData = { name, email, password }
            await teacherCollection.insertMany([teacherData])
            res.redirect(`/homeTeacher?userName=${encodeURIComponent(name)}`)
        } else {
            const studentData = { name, enrollment, password }
            await studentCollection.insertMany([studentData])
            res.redirect(`/homeStudent?userName=${encodeURIComponent(name)}`)
        }
    } catch (error) {
        console.error('❌ Signup error:', error)
        res.send("Error during registration")
    }
})

// Handle user login
app.post("/login", async (req, res) => {
    try {
        const { name, password, userType, email, enrollment } = req.body
        let user

        if (userType === 'teacher') {
            user = await teacherCollection.findOne({ email: email })
        } else {
            user = await studentCollection.findOne({ enrollment: enrollment })
        }

        if (user && user.password === password) {
            const redirectUrl = userType === 'teacher' ? '/homeTeacher' : '/homeStudent'
            res.redirect(`${redirectUrl}?userName=${encodeURIComponent(user.name)}`)
        } else {
            res.send("Wrong credentials")
        }
    } catch (error) {
        console.error('❌ Login error:', error)
        res.send("Login failed")
    }
})

// Logout route
app.get('/logout', (req, res) => {
    res.redirect('/login')
})

// ==================== DASHBOARD ROUTES ====================

// Student dashboard
app.get("/homeStudent", (req, res) => {
    res.render("homeStudent", {
        userType: "student",
        userName: req.query.userName || "Student"
    })
})

// Teacher dashboard with lecture statistics
app.get("/homeTeacher", async (req, res) => {
    try {
        const lectures = await lectureCollection.find({}).sort({ uploadDate: -1 })
        
        // Calculate dashboard statistics
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
            ...stats,
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

// ==================== LECTURE MANAGEMENT ROUTES ====================

// Upload and process lecture files
app.post("/upload_lecture", upload.single('lectureFile'), async (req, res) => {
    let tempFilePath = null
    
    try {
        if (!req.file) {
            return res.status(400).json({ 
                success: false, 
                message: 'No file uploaded' 
            })
        }

        const { title } = req.body
        const file = req.file
        tempFilePath = file.path

        console.log('📁 Processing file:', {
            originalName: file.originalname,
            size: file.size,
            mimetype: file.mimetype,
            tempPath: file.path
        })

        // Extract text from uploaded file
        const extractedText = await extractTextFromFile(file.path, file.mimetype)
        
        console.log('📝 Text extraction completed:', {
            totalLength: extractedText.length,
            preview: extractedText.substring(0, 200) + '...'
        })

        // Save extracted text and metadata to database
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
        console.log('✅ Lecture saved to database:', savedLecture._id)

        // Clean up temporary file
        cleanupTempFile(tempFilePath)

        res.redirect('/homeTeacher?upload=success&title=' + encodeURIComponent(title))

    } catch (error) {
        console.error('❌ Upload processing error:', error)
        
        if (tempFilePath) {
            cleanupTempFile(tempFilePath)
        }
        
        res.status(500).json({ 
            success: false, 
            message: 'Failed to process uploaded file: ' + error.message 
        })
    }
})

// Get lecture text content for AI processing
app.get('/lectures/:id/text', async (req, res) => {
    try {
        const lecture = await lectureCollection.findById(req.params.id)
            .select('extractedText title textLength')
        
        if (!lecture) {
            return res.status(404).json({ 
                success: false, 
                message: 'Lecture not found' 
            })
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
        res.status(500).json({ 
            success: false, 
            message: 'Error loading lecture text' 
        })
    }
})

// Generate quiz from lecture content - AI integration point
app.post('/generate_quiz/:id', async (req, res) => {
    try {
        const lectureId = req.params.id
        const lecture = await lectureCollection.findById(lectureId)
        
        if (!lecture) {
            return res.status(404).json({ 
                success: false, 
                message: 'Lecture not found' 
            })
        }

        // Update processing status
        await lectureCollection.findByIdAndUpdate(lectureId, { 
            processingStatus: 'processing',
            lastProcessed: new Date()
        })
        
        console.log('🤖 AI Quiz Generation Started:', {
            lecture: lecture.title,
            textLength: lecture.textLength
        })
        
        // *** AI INTEGRATION POINT ***
        // TODO: Replace this section with actual AI API call
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
            generatedDate: new Date()
        };
        
        await quizCollection.create(generatedQuiz);
        */
        
        // Temporary: Mark as generated (remove when AI is integrated)
        await lectureCollection.findByIdAndUpdate(lectureId, { 
            quizGenerated: true,
            processingStatus: 'completed',
            quizzesCount: 1
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
        
        await lectureCollection.findByIdAndUpdate(req.params.id, { 
            processingStatus: 'failed'
        })
        
        res.status(500).json({ 
            success: false, 
            message: 'Failed to generate quiz' 
        })
    }
})

// Delete lecture and associated quizzes
app.post('/delete_lecture/:id', async (req, res) => {
    try {
        const lectureId = req.params.id
        const lecture = await lectureCollection.findById(lectureId)
        
        if (!lecture) {
            return res.status(404).json({ 
                success: false, 
                message: 'Lecture not found' 
            })
        }
        
        // Delete associated quizzes first
        await quizCollection.deleteMany({ lectureId: lectureId })
        
        // Delete lecture record
        await lectureCollection.findByIdAndDelete(lectureId)
        
        console.log('🗑️ Lecture and quizzes deleted:', lecture.title)
        
        res.json({ 
            success: true, 
            message: 'Lecture deleted successfully' 
        })
    } catch (error) {
        console.error('❌ Error deleting lecture:', error)
        res.status(500).json({ 
            success: false, 
            message: 'Failed to delete lecture' 
        })
    }
})

// ==================== ERROR HANDLING ====================

// Multer error handling middleware
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

// ==================== SERVER STARTUP ====================

app.listen(PORT, () => {
    console.log(`🚀 QuizAI Server started on port ${PORT}`)
    
    // Clean up any temporary files from previous runs
    cleanupTempFiles()
    
    console.log('📚 Ready to process lecture uploads and generate quizzes!')
})