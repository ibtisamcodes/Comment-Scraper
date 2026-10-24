require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.YOUTUBE_API_KEY;
const YT = "https://www.googleapis.com/youtube/v3";

app.use(express.static(path.join(__dirname, "public")));

// ---------- helpers ----------
async function yt(endpoint, params) {
  const url = new URL(`${YT}/${endpoint}`);
  Object.entries({ ...params, key: API_KEY }).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.error?.message || "YouTube API request failed");
    err.status = res.status;
    err.reason = data?.error?.errors?.[0]?.reason;
    throw err;
  }
  return data;
}

function requireKey(req, res, next) {
  if (!API_KEY || API_KEY === "your_api_key_here") {
    return res.status(500).json({
      error:
        "Missing YouTube API key. Add YOUTUBE_API_KEY to your .env file and restart the server.",
    });
  }
  next();
}

function handleError(res, err) {
  console.error("API error:", err.message);
  let message = err.message;
  if (err.reason === "commentsDisabled") message = "Comments are disabled for this video.";
  if (err.reason === "quotaExceeded") message = "Daily YouTube API quota exceeded. Try again tomorrow.";
  res.status(err.status || 500).json({ error: message });
}

// ---------- find channel + list its matching videos ----------
app.get("/api/youtube/videos", requireKey, async (req, res) => {
  try {
    const channelQuery = (req.query.channel || "").trim();
    const videoQuery = (req.query.video || "").trim();
    if (!channelQuery || !videoQuery) {
      return res.status(400).json({ error: "Please enter both a channel name and a video name." });
    }

    // 1) Resolve channel (supports @handle or plain name)
    let channel;
    if (channelQuery.startsWith("@")) {
      const r = await yt("channels", { part: "snippet", forHandle: channelQuery });
      channel = r.items?.[0];
      if (channel) channel = { id: channel.id, title: channel.snippet.title, thumb: channel.snippet.thumbnails?.default?.url };
    }
    if (!channel) {
      const r = await yt("search", { part: "snippet", type: "channel", q: channelQuery, maxResults: 1 });
      const c = r.items?.[0];
      if (c) channel = { id: c.snippet.channelId, title: c.snippet.channelTitle || c.snippet.title, thumb: c.snippet.thumbnails?.default?.url };
    }
    if (!channel) return res.status(404).json({ error: `No channel found for "${channelQuery}".` });

    // 2) Search videos inside that channel
    const s = await yt("search", {
      part: "snippet",
      type: "video",
      channelId: channel.id,
      q: videoQuery,
      maxResults: 12,
      order: "relevance",
    });
    const ids = (s.items || []).map((i) => i.id.videoId).filter(Boolean);
    if (!ids.length) {
      return res.status(404).json({ error: `No videos matching "${videoQuery}" found on ${channel.title}.` });
    }

    // 3) Get stats (comment counts etc.)
    const v = await yt("videos", { part: "snippet,statistics", id: ids.join(",") });
    const videos = (v.items || []).map((i) => ({
      id: i.id,
      title: i.snippet.title,
      publishedAt: i.snippet.publishedAt,
      thumbnail: i.snippet.thumbnails?.medium?.url || i.snippet.thumbnails?.default?.url,
      views: Number(i.statistics?.viewCount || 0),
      commentCount: i.statistics?.commentCount !== undefined ? Number(i.statistics.commentCount) : null,
    }));

    res.json({ channel, videos });
  } catch (err) {
    handleError(res, err);
  }
});

// ---------- scrape comments for a chosen video ----------
app.get("/api/youtube/comments", requireKey, async (req, res) => {
  try {
    const videoId = (req.query.videoId || "").trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 5000);
    const order = req.query.order === "time" ? "time" : "relevance";
    const includeReplies = req.query.replies === "true";
    if (!videoId) return res.status(400).json({ error: "videoId is required." });

    const comments = [];
    let pageToken;
    while (comments.length < limit) {
      const data = await yt("commentThreads", {
        part: includeReplies ? "snippet,replies" : "snippet",
        videoId,
        maxResults: 100,
        order,
        textFormat: "plainText",
        pageToken,
      });

      for (const item of data.items || []) {
        const top = item.snippet.topLevelComment.snippet;
        comments.push({
          type: "comment",
          author: top.authorDisplayName,
          text: top.textDisplay,
          likes: top.likeCount,
          publishedAt: top.publishedAt,
          replyCount: item.snippet.totalReplyCount,
        });
        for (const rep of item.replies?.comments || []) {
          comments.push({
            type: "reply",
            author: rep.snippet.authorDisplayName,
            text: rep.snippet.textDisplay,
            likes: rep.snippet.likeCount,
            publishedAt: rep.snippet.publishedAt,
            replyCount: 0,
          });
        }
      }

      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }

    res.json({ count: Math.min(comments.length, limit), comments: comments.slice(0, limit) });
  } catch (err) {
    handleError(res, err);
  }
});

app.listen(PORT, () => {
  console.log(`\n  Comment Scraper running at http://localhost:${PORT}\n`);
  if (!API_KEY || API_KEY === "AIzaSyDOqGPKdb_YjHvuzWSEIbULYx1Ipxpo1fY") {
    console.log("  WARNING: YOUTUBE_API_KEY is not set. Edit your .env file first.\n");
  }
});
