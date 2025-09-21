// services/aiService.js
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

class AIService {
    constructor() {
        this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        this.model = this.genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        // Configuration for AI generation
        this.generationConfig = {
            temperature: 0.3,
            topP: 0.8,
            topK: 40,
            maxOutputTokens: 8192,
            responseMimeType: "application/json",
        };

        this.safetySettings = [
            {
                category: HarmCategory.HARM_CATEGORY_HARASSMENT,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            },
            {
                category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            },
            {
                category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            },
            {
                category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            },
        ];
    }

    /**
     * Generate quiz from lecture content with enhanced explanations
     */
    async generateQuiz(lectureContent, options = {}) {
        const {
            questionsToGenerate = 10,
            customDuration = 15,
            examMode = false,
            examWindowDuration = 60
        } = options;

        console.log('🤖 Starting AI quiz generation:', {
            questionsCount: questionsToGenerate,
            duration: customDuration,
            examMode: examMode
        });

        try {
            const examModeText = examMode ? 
                `This quiz will be used as a timed exam with a ${examWindowDuration}-minute window. Generate challenging but fair questions appropriate for an exam setting.` :
                `This quiz will be used for regular practice and learning.`;

            const prompt = this._buildQuizPrompt(lectureContent, questionsToGenerate, customDuration, examModeText);
            
            const result = await this.model.generateContent({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig: this.generationConfig,
                safetySettings: this.safetySettings,
            });

            const response = result.response;
            let quizContent = response.text();

            console.log('✅ Received response from Gemini API');

            // Parse and validate the AI response
            const generatedQuiz = this._parseAndValidateQuiz(quizContent, questionsToGenerate);

            console.log('🎯 Quiz validated:', {
                totalQuestions: generatedQuiz.length,
                requestedQuestions: questionsToGenerate,
                hasExplanations: !!generatedQuiz[0]?.explanations,
                hasCorrectExplanation: !!generatedQuiz[0]?.correctAnswerExplanation
            });

            return {
                success: true,
                quiz: generatedQuiz,
                metadata: {
                    questionsGenerated: generatedQuiz.length,
                    durationMinutes: customDuration,
                    examMode: examMode,
                    explanationsIncluded: true
                }
            };

        } catch (error) {
            console.error('❌ AI Quiz Generation Error:', error);
            
            if (error.message.includes('quota') || error.message.includes('limit')) {
                return {
                    success: false,
                    error: 'API_QUOTA_EXCEEDED',
                    message: 'API quota exceeded. Please try again later.'
                };
            }

            return {
                success: false,
                error: 'AI_GENERATION_FAILED',
                message: 'Failed to generate quiz. Please check your API key and try again.'
            };
        }
    }

    /**
     * Build the prompt for quiz generation
     */
    _buildQuizPrompt(lectureContent, questionsToGenerate, customDuration, examModeText) {
        return `
        You are an expert quiz generator and educational content creator. Create a comprehensive multiple-choice quiz with detailed explanations based on the following lecture content.

        **QUIZ CONTEXT:** ${examModeText}

        **CRITICAL REQUIREMENTS - MUST FOLLOW EXACTLY:**
        1. Generate EXACTLY ${questionsToGenerate} multiple-choice questions (NO MORE, NO LESS)
        2. Quiz duration is EXACTLY ${customDuration} minutes
        3. Each question must have exactly 4 options (A, B, C, D)
        4. Questions should test understanding, not just memorization
        5. Mix difficulty levels: 30% easy, 40% medium, 30% hard questions
        6. Ensure all questions are directly based on the lecture content
        7. Make wrong options plausible but clearly incorrect
        8. Provide detailed explanations for EACH wrong answer option
        9. Provide a comprehensive explanation for the correct answer
        10. Output must be valid JSON only, no extra text

        **LECTURE CONTENT:**
        ${lectureContent.substring(0, 4000)}

        **REQUIRED JSON FORMAT - MUST INCLUDE EXPLANATIONS:**
        [
          {
            "question": "Clear, complete question text here?",
            "options": {
              "A": "First option",
              "B": "Second option", 
              "C": "Third option",
              "D": "Fourth option"
            },
            "correct_answer": "B",
            "correctAnswerExplanation": "Detailed explanation of why B is correct, referencing specific content from the lecture.",
            "explanations": {
              "A": "Explanation of why A is incorrect and what concept it might confuse with specific reference to lecture content",
              "B": "",
              "C": "Explanation of why C is incorrect and what the student might have misunderstood, with reference to lecture material",
              "D": "Explanation of why D is incorrect and how to avoid this mistake, connecting to lecture concepts"
            }
          }
        ]

        CRITICAL: Generate EXACTLY ${questionsToGenerate} questions for a ${customDuration}-minute quiz.`;
    }

    /**
     * Parse and validate the AI quiz response
     */
    _parseAndValidateQuiz(quizContent, questionsToGenerate) {
        try {
            quizContent = quizContent.trim();
            if (quizContent.startsWith('```json')) {
                quizContent = quizContent.substring(7, quizContent.lastIndexOf('```')).trim();
            }

            const generatedQuiz = JSON.parse(quizContent);

            // Validate structure
            if (!Array.isArray(generatedQuiz)) {
                throw new Error('Response is not an array');
            }

            // Adjust array length if needed
            if (generatedQuiz.length !== questionsToGenerate) {
                console.warn(`⚠️ AI generated ${generatedQuiz.length} questions, expected ${questionsToGenerate}`);
                if (generatedQuiz.length > questionsToGenerate) {
                    generatedQuiz.splice(questionsToGenerate);
                    console.log(`✂️ Trimmed to ${questionsToGenerate} questions`);
                }
            }

            if (generatedQuiz.length === 0) {
                throw new Error('No questions generated');
            }

            // Validate each question
            generatedQuiz.forEach((q, index) => {
                if (!q.question || !q.options || !q.correct_answer || !q.explanations || !q.correctAnswerExplanation) {
                    throw new Error(`Question ${index + 1} is missing required fields (including explanations)`);
                }
                if (!['A', 'B', 'C', 'D'].includes(q.correct_answer)) {
                    throw new Error(`Question ${index + 1} has invalid correct_answer`);
                }

                // Ensure explanations exist for wrong answers
                ['A', 'B', 'C', 'D'].forEach(option => {
                    if (option !== q.correct_answer && (!q.explanations[option] || q.explanations[option].trim() === '')) {
                        console.warn(`⚠️ Question ${index + 1}: Missing explanation for wrong answer ${option}`);
                        q.explanations[option] = `This option is incorrect. The correct answer is ${q.correct_answer}. Please review the lecture material for more details.`;
                    }
                });

                q.explanations[q.correct_answer] = "";
            });

            return generatedQuiz;

        } catch (parseError) {
            console.error('❌ Failed to parse quiz JSON:', parseError);
            throw new Error('Enhanced AI response parsing failed: ' + parseError.message);
        }
    }

    /**
     * Generate explanation for a specific wrong answer
     */
    async generateExplanation(questionText, correctAnswer, wrongAnswer, lectureContent) {
        try {
            const prompt = `
            You are an educational AI assistant. A student answered a quiz question incorrectly. 
            Provide a helpful explanation for why their answer was wrong and guide them to the correct understanding.

            **Question:** ${questionText}
            **Correct Answer:** ${correctAnswer}
            **Student's Wrong Answer:** ${wrongAnswer}
            **Lecture Context:** ${lectureContent.substring(0, 1000)}

            Provide a clear, educational explanation that:
            1. Explains why the student's answer is incorrect
            2. Explains why the correct answer is right
            3. References the lecture material
            4. Is encouraging and educational

            Keep the explanation concise but comprehensive (2-3 sentences).
            `;

            const result = await this.model.generateContent({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.5,
                    maxOutputTokens: 512
                },
                safetySettings: this.safetySettings,
            });

            const explanation = result.response.text().trim();
            
            return {
                success: true,
                explanation: explanation
            };

        } catch (error) {
            console.error('❌ Error generating explanation:', error);
            return {
                success: false,
                error: 'Failed to generate explanation',
                fallback: `The correct answer is ${correctAnswer}. Please review the lecture material for more details.`
            };
        }
    }

    /**
     * Check API health and quota
     */
    async checkAPIHealth() {
        try {
            const testPrompt = "Generate a simple test response: Hello";
            const result = await this.model.generateContent({
                contents: [{ role: "user", parts: [{ text: testPrompt }] }],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 50
                }
            });

            const response = result.response.text();
            
            return {
                success: true,
                status: 'healthy',
                message: 'API is working correctly',
                testResponse: response
            };

        } catch (error) {
            console.error('❌ API Health Check Failed:', error);
            
            return {
                success: false,
                status: 'unhealthy',
                error: error.message,
                message: 'API is not responding correctly'
            };
        }
    }
}

// Export singleton instance
const aiService = new AIService();
module.exports = aiService;