// services/fileService.js
const fs = require('fs');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const PptxParser = require('node-pptx-parser').default;

class FileService {
    constructor() {
        this.supportedMimeTypes = [
            'application/pdf',
            'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ];
    }

    /**
     * Extract text from uploaded file based on its type
     */
    async extractTextFromFile(filePath, mimetype) {
        console.log(`📄 Starting text extraction for: ${mimetype}`);

        try {
            switch (mimetype) {
                case 'application/pdf':
                    return await this.extractTextFromPDF(filePath);
                
                case 'application/msword':
                case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
                    return await this.extractTextFromWord(filePath);
                
                case 'application/vnd.ms-powerpoint':
                case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
                    return await this.extractTextFromPowerPoint(filePath);
                
                default:
                    throw new Error(`Unsupported file type: ${mimetype}`);
            }
        } catch (error) {
            console.error('❌ Text extraction failed:', error);
            throw new Error(`Failed to extract text from file: ${error.message}`);
        }
    }

    /**
     * Extract text from PDF files
     */
    async extractTextFromPDF(filePath) {
        try {
            console.log(`📌 Starting PDF text extraction for: ${filePath}`);
            const dataBuffer = fs.readFileSync(filePath);
            const data = await pdfParse(dataBuffer);
            const extractedText = data.text.trim();
            
            if (!extractedText || extractedText.length < 10) {
                throw new Error('PDF appears to be empty or contains no readable text');
            }

            console.log('✅ PDF text extracted successfully (first 500 chars):', extractedText.substring(0, 500));
            return extractedText;
            
        } catch (error) {
            console.error('❌ Error extracting text from PDF:', error);
            throw new Error(`PDF extraction failed: ${error.message}`);
        }
    }

    /**
     * Extract text from Word documents
     */
    async extractTextFromWord(filePath) {
        try {
            console.log(`📌 Starting Word text extraction for: ${filePath}`);
            const result = await mammoth.extractRawText({ path: filePath });
            const extractedText = result.value.trim();
            
            if (!extractedText || extractedText.length < 10) {
                throw new Error('Word document appears to be empty or contains no readable text');
            }

            console.log('✅ Word text extracted successfully (first 500 chars):', extractedText.substring(0, 500));
            return extractedText;
            
        } catch (error) {
            console.error('❌ Error extracting text from Word:', error);
            throw new Error(`Word extraction failed: ${error.message}`);
        }
    }

    /**
     * Extract text from PowerPoint presentations
     */
    async extractTextFromPowerPoint(filePath) {
        try {
            console.log(`📌 Initializing PptxParser for: ${filePath}`);
            const parser = new PptxParser(filePath);

            console.log('📄 Extracting text using node-pptx-parser...');
            const textContent = await parser.extractText();

            let extractedText = '';
            if (textContent && textContent.length > 0) {
                extractedText = textContent
                    .map(slide => slide.text.join('\n'))
                    .join('\n\n')
                    .trim();
                
                console.log('✅ PPTX text extracted successfully (first 500 chars):', extractedText.substring(0, 500));
            } else {
                console.warn('⚠️ node-pptx-parser extracted no text from the PPTX file.');
            }

            if (!extractedText || extractedText.length < 10) {
                throw new Error('PowerPoint presentation appears to be empty or contains no readable text');
            }

            return extractedText;
            
        } catch (error) {
            console.error('❌ Error extracting text from PowerPoint:', error);
            throw new Error(`PowerPoint extraction failed: ${error.message}`);
        }
    }

    /**
     * Validate file type and size
     */
    validateFile(file, maxSize = 100 * 1024 * 1024) {
        const errors = [];

        // Check if file exists
        if (!file) {
            errors.push('No file provided');
            return { isValid: false, errors };
        }

        // Check file size
        if (file.size > maxSize) {
            errors.push(`File size (${Math.round(file.size / 1024 / 1024)}MB) exceeds maximum allowed size (${Math.round(maxSize / 1024 / 1024)}MB)`);
        }

        // Check file type
        if (!this.supportedMimeTypes.includes(file.mimetype)) {
            errors.push(`File type '${file.mimetype}' is not supported. Allowed types: PDF, PPT, PPTX, DOC, DOCX`);
        }

        // Check filename
        if (!file.originalname || file.originalname.length < 3) {
            errors.push('Invalid filename');
        }

        return {
            isValid: errors.length === 0,
            errors: errors
        };
    }

    /**
     * Get file type from mime type
     */
    getFileType(mimetype) {
        const typeMap = {
            'application/pdf': 'pdf',
            'application/msword': 'docx',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
            'application/vnd.ms-powerpoint': 'pptx',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
        };
        return typeMap[mimetype] || 'unknown';
    }

    /**
     * Get file icon based on type
     */
    getFileIcon(mimetype) {
        const iconMap = {
            'application/pdf': '📄',
            'application/msword': '📝',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '📝',
            'application/vnd.ms-powerpoint': '📊',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation': '📊'
        };
        return iconMap[mimetype] || '📎';
    }

    /**
     * Format file size for display
     */
    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';

        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));

        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * Clean up temporary file
     */
    cleanupTempFile(filePath) {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`🗑️ Temporary file deleted: ${filePath}`);
                return true;
            }
            return false;
        } catch (error) {
            console.error('⚠️ Error cleaning up temporary file:', error);
            return false;
        }
    }

    /**
     * Process uploaded file and extract metadata
     */
    async processUploadedFile(file, options = {}) {
        const { 
            extractText = true, 
            validateFile = true,
            cleanupAfter = true 
        } = options;

        console.log('📎 Processing uploaded file:', {
            originalName: file.originalname,
            size: this.formatFileSize(file.size),
            mimetype: file.mimetype,
            path: file.path
        });

        try {
            // Validate file if requested
            if (validateFile) {
                const validation = this.validateFile(file);
                if (!validation.isValid) {
                    throw new Error(`File validation failed: ${validation.errors.join(', ')}`);
                }
            }

            const result = {
                originalFileName: file.originalname,
                mimeType: file.mimetype,
                fileSize: file.size,
                fileType: this.getFileType(file.mimetype),
                fileIcon: this.getFileIcon(file.mimetype),
                formattedSize: this.formatFileSize(file.size),
                uploadDate: new Date(),
                extractedText: null,
                textLength: 0
            };

            // Extract text if requested
            if (extractText) {
                try {
                    result.extractedText = await this.extractTextFromFile(file.path, file.mimetype);
                    result.textLength = result.extractedText.length;
                    
                    console.log('📄 Text extraction completed:', {
                        textLength: result.textLength,
                        preview: result.extractedText.substring(0, 200) + '...'
                    });
                } catch (extractionError) {
                    console.error('❌ Text extraction failed:', extractionError);
                    result.extractionError = extractionError.message;
                }
            }

            // Cleanup temporary file if requested
            if (cleanupAfter) {
                this.cleanupTempFile(file.path);
            }

            return {
                success: true,
                data: result
            };

        } catch (error) {
            // Cleanup on error
            if (cleanupAfter) {
                this.cleanupTempFile(file.path);
            }

            console.error('❌ File processing failed:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Get supported file types for frontend
     */
    getSupportedTypes() {
        return {
            mimeTypes: this.supportedMimeTypes,
            extensions: ['.pdf', '.ppt', '.pptx', '.doc', '.docx'],
            description: 'PDF, PowerPoint, and Word documents'
        };
    }
}

// Export singleton instance
const fileService = new FileService();
module.exports = fileService;