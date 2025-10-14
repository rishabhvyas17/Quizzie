// middleware/uploadMiddleware.js
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configuration constants
const TEMP_UPLOAD_DIR = './temp_uploads';
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

// Ensure temp directory exists
const ensureTempDirectory = () => {
    if (!fs.existsSync(TEMP_UPLOAD_DIR)) {
        fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });
        console.log(`📁 Created temp upload directory: ${TEMP_UPLOAD_DIR}`);
    }
};

// Configure multer storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        ensureTempDirectory();
        cb(null, TEMP_UPLOAD_DIR);
    },
    filename: function (req, file, cb) {
        const uniqueName = Date.now() + '-' + file.originalname;
        cb(null, uniqueName);
    }
});

// File type validation
const fileFilter = (req, file, cb) => {
    const allowedMimes = [
        'application/pdf',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];

    if (allowedMimes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        req.fileError = new Error('Invalid file type. Only PDF, PPT, PPTX, DOC, DOCX files are allowed.');
        cb(null, false);
    }
};

// Main upload middleware configuration
const upload = multer({
    storage: storage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: fileFilter
});

/**
 * Middleware to handle file upload errors
 */
const handleUploadError = (error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            const redirectUrl = req.session?.userType === 'teacher' ? '/homeTeacher' : '/login';
            const message = encodeURIComponent('File too large. Maximum size is 100MB.');
            return res.status(400).redirect(`${redirectUrl}?uploadError=true&message=${message}`);
        }
        const redirectUrl = req.session?.userType === 'teacher' ? '/homeTeacher' : '/login';
        const message = encodeURIComponent('File upload error: ' + error.message);
        return res.status(400).redirect(`${redirectUrl}?uploadError=true&message=${message}`);
    }

    if (req.fileError) {
        const redirectUrl = req.session?.userType === 'teacher' ? '/homeTeacher' : '/login';
        const message = encodeURIComponent(req.fileError.message);
        return res.status(400).redirect(`${redirectUrl}?uploadError=true&message=${message}`);
    }

    next(error);
};

/**
 * Utility function to clean up temporary files
 */
const cleanupTempFile = (filePath) => {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ Temporary file deleted: ${filePath}`);
        }
    } catch (error) {
        console.error('⚠️ Error cleaning up temporary file:', error);
    }
};

/**
 * Clean up all temporary files
 */
const cleanupTempFiles = () => {
    if (fs.existsSync(TEMP_UPLOAD_DIR)) {
        const files = fs.readdirSync(TEMP_UPLOAD_DIR);
        files.forEach(file => {
            const filePath = path.join(TEMP_UPLOAD_DIR, file);
            try {
                fs.unlinkSync(filePath);
                console.log(`🗑️ Cleaned up old temp file: ${file}`);
            } catch (error) {
                console.error(`⚠️ Could not clean up temp file ${file}:`, error);
            }
        });
    }
};

/**
 * Get file type from mime type
 */
const getFileType = (mimetype) => {
    const typeMap = {
        'application/pdf': 'pdf',
        'application/msword': 'docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.ms-powerpoint': 'pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
    };
    return typeMap[mimetype] || 'unknown';
};

/**
 * Validate uploaded file
 */
const validateUploadedFile = (req, res, next) => {
    if (req.fileError) {
        return res.status(400).json({
            success: false,
            message: req.fileError.message
        });
    }

    if (!req.file) {
        return res.status(400).json({
            success: false,
            message: 'No file uploaded'
        });
    }

    // Add file metadata to request
    req.fileMetadata = {
        originalName: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
        path: req.file.path,
        fileType: getFileType(req.file.mimetype)
    };

    console.log('📎 File validated:', {
        name: req.file.originalname,
        size: `${Math.round(req.file.size / 1024)}KB`,
        type: req.fileMetadata.fileType
    });

    next();
};

module.exports = {
    upload,
    handleUploadError,
    validateUploadedFile,
    cleanupTempFile,
    cleanupTempFiles,
    getFileType,
    TEMP_UPLOAD_DIR,
    MAX_FILE_SIZE
};