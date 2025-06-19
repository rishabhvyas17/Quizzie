const mongoose = require('mongoose')
const { quizCollection, lectureCollection } = require('./mongodb')

async function detailedQuizCheck() {
    try {
        await mongoose.connect("mongodb://localhost:27017/QuizAI")
        console.log("✅ Connected to MongoDB")
        
        // Get all quizzes with full details
        const quizzes = await quizCollection.find({}).lean()
        console.log(`\n📚 Found ${quizzes.length} quizzes:`)
        
        quizzes.forEach((quiz, index) => {
            console.log(`\n--- Quiz ${index + 1} ---`)
            console.log(`ID: ${quiz._id}`)
            console.log(`Lecture Title: ${quiz.lectureTitle}`)
            console.log(`Lecture ID: ${quiz.lectureId}`)
            console.log(`Total Questions: ${quiz.totalQuestions}`)
            console.log(`Generated Date: ${quiz.generatedDate}`)
            console.log(`Created Date: ${quiz.createdAt}`)
            console.log(`Created By: ${quiz.createdBy}`)
            console.log(`Is Active: ${quiz.isActive}`)
            console.log(`Questions Count: ${quiz.questions ? quiz.questions.length : 0}`)
            
            if (quiz.questions && quiz.questions.length > 0) {
                console.log(`First Question: ${quiz.questions[0].question}`)
                console.log(`Answer Options: ${JSON.stringify(quiz.questions[0].options)}`)
                console.log(`Correct Answer: ${quiz.questions[0].correct_answer}`)
            }
        })
        
        // Check corresponding lectures
        console.log(`\n📖 Checking corresponding lectures:`)
        for (const quiz of quizzes) {
            const lecture = await lectureCollection.findById(quiz.lectureId)
            if (lecture) {
                console.log(`- Lecture "${lecture.title}" exists for quiz "${quiz.lectureTitle}"`)
                console.log(`  Quiz Generated Flag: ${lecture.quizGenerated}`)
                console.log(`  Processing Status: ${lecture.processingStatus}`)
            } else {
                console.log(`❌ No lecture found for quiz "${quiz.lectureTitle}" (ID: ${quiz.lectureId})`)
            }
        }
        
        process.exit(0)
    } catch (error) {
        console.error('❌ Error:', error)
        process.exit(1)
    }
}

detailedQuizCheck()