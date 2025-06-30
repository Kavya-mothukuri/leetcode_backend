// server.js
const express = require('express');
const { createClient } = require('redis');
const axios = require('axios');
const cors = require('cors');

const app = express();
const port = 3000;

app.use(cors({
  origin: 'http://localhost:5173',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json());

const redisClient = createClient({
  url: process.env.UPSTASH_REDIS_URL
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));
(async () => {
  try {
    await redisClient.connect();
    console.log('Redis connected');
  } catch (err) {
    console.error('Failed to connect to Redis', err);
  }
})();

const headers = {
  'Content-Type': 'application/json',
  'Referer': 'https://leetcode.com',
  'User-Agent': 'Mozilla/5.0',
};

// GraphQL Queries
const baseQuery = `
  query userPublicProfile($username: String!) {
    matchedUser(username: $username) {
      username
      profile {
        realName
        userAvatar
        ranking
        countryName
        reputation
        aboutMe
        school
        websites
        skillTags
        company
        jobTitle
      }
      submitStatsGlobal {
        acSubmissionNum {
          difficulty
          count
          submissions
        }
        totalSubmissionNum {
          difficulty
          count
          submissions
        }
      }
    }
    userContestRanking(username: $username) {
      attendedContestsCount
      rating
      globalRanking
      topPercentage
      badge {
        name
        expired
        hoverText
        icon
      }
    }
    userContestRankingHistory(username: $username) {
      attended
      trendDirection
      problemsSolved
      totalProblems
      finishTimeInSeconds
      rating
      ranking
      contest {
        title
        startTime
      }
    }
  }
`;

const languageStatsQuery = `
  query languageStats($username: String!) {
    matchedUser(username: $username) {
      languageProblemCount {
        languageName
        problemsSolved
      }
    }
  }
`;

const calendarQuery = `
  query userProfileCalendar($username: String!, $year: Int) {
    matchedUser(username: $username) {
      userCalendar(year: $year) {
        activeYears
        streak
        totalActiveDays
        submissionCalendar
      }
    }
  }
`;

// Helpers
function parseAndFilterCalendar(submissionCalendar, fromDate) {
  const parsed = typeof submissionCalendar === 'string'
    ? JSON.parse(submissionCalendar)
    : submissionCalendar;

  return Object.entries(parsed).map(([timestamp, count]) => {
    const date = new Date(parseInt(timestamp) * 1000);
    return {
      date: date.toISOString().split('T')[0], // yyyy-mm-dd
      count,
    };
  }).filter(entry => new Date(entry.date) >= fromDate)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

// Fetch profile + contest data
async function fetchUserData(username) {
  const cacheKey = `user:${username}`;
  const cached = await redisClient.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const response = await axios.post('https://leetcode.com/graphql', {
    query: baseQuery,
    variables: { username },
  }, { headers });

  const data = response.data.data;
  if (!data || !data.matchedUser) {
    throw new Error(`User "${username}" not found`);
  }

  await redisClient.setEx(cacheKey, 3600, JSON.stringify(data));
  return data;
}

// Fetch language stats + last 12-month calendar
async function fetchExtraStats(username) {
  const toDate = new Date();
  const fromDate = new Date(toDate);
  fromDate.setFullYear(toDate.getFullYear() - 1);
  fromDate.setDate(1); // start from beginning of that month

  const thisYear = toDate.getFullYear();
  const lastYear = thisYear - 1;
  const cacheKey = `user:rolling:${username}:${lastYear}-${thisYear}`;

  const cached = await redisClient.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const [langRes, calRes1, calRes2] = await Promise.all([
    axios.post('https://leetcode.com/graphql', {
      query: languageStatsQuery,
      variables: { username },
    }, { headers }),

    axios.post('https://leetcode.com/graphql', {
      query: calendarQuery,
      variables: { username, year: lastYear },
    }, { headers }),

    axios.post('https://leetcode.com/graphql', {
      query: calendarQuery,
      variables: { username, year: thisYear },
    }, { headers }),
  ]);

  const languageStatsRaw = langRes.data?.data?.matchedUser?.languageProblemCount || [];
  const languageStats = languageStatsRaw.map(({ languageName, problemsSolved }) => ({
    language: languageName,
    problemsSolved,
  }));

  const calRaw1 = calRes1.data?.data?.matchedUser?.userCalendar?.submissionCalendar || "{}";
  const calRaw2 = calRes2.data?.data?.matchedUser?.userCalendar?.submissionCalendar || "{}";

  const parsed1 = parseAndFilterCalendar(calRaw1, fromDate);
  const parsed2 = parseAndFilterCalendar(calRaw2, fromDate);
  const combinedCalendar = [...parsed1, ...parsed2];

  const result = {
    languageStats,
    calendar: combinedCalendar,
  };

  await redisClient.setEx(cacheKey, 3600, JSON.stringify(result));
  return result;
}

// Route: GET /user/:username
app.get('/user/:username', async (req, res) => {
  const username = req.params.username;

  try {
    const [profileData, extraStats] = await Promise.all([
      fetchUserData(username),
      fetchExtraStats(username),
    ]);

    res.json({
      ...profileData,
      languageStats: extraStats.languageStats,
      calendar: extraStats.calendar,
    });
  } catch (error) {
    console.error('GraphQL Error:', error?.response?.data?.errors || error.message || error);
    res.status(500).send('Error fetching full user data');
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
