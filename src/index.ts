import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";

// SQLite database path
const DB_PATH = process.env.DB_PATH || "./knowledge.db";

// Create server instance
const server = new McpServer({
  name: "knowledge-vault",
  version: "1.0.0"
});

let db: Database;

// Initialize the database
async function initializeDb() {
  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  // Create tables if they don't exist
  await db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      category_id INTEGER,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories (id),
      UNIQUE (slug, category_id)
    );

    CREATE INDEX IF NOT EXISTS idx_topics_slug ON topics (slug);
    CREATE INDEX IF NOT EXISTS idx_topics_category ON topics (category_id);

    CREATE TABLE IF NOT EXISTS topic_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      relationship_type TEXT NOT NULL,
      relationship_strength REAL NOT NULL DEFAULT 0.5,
      FOREIGN KEY (source_id) REFERENCES topics (id),
      FOREIGN KEY (target_id) REFERENCES topics (id),
      UNIQUE(source_id, target_id, relationship_type)
    );

    CREATE INDEX IF NOT EXISTS idx_topic_relations_source ON topic_relations (source_id);
    CREATE INDEX IF NOT EXISTS idx_topic_relations_target ON topic_relations (target_id);

    CREATE TABLE IF NOT EXISTS topic_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      changed_by TEXT DEFAULT 'system',
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      change_comment TEXT,
      FOREIGN KEY (topic_id) REFERENCES topics (id)
    );

    CREATE INDEX IF NOT EXISTS idx_topic_history_topic ON topic_history (topic_id);
    CREATE INDEX IF NOT EXISTS idx_topic_history_date ON topic_history (changed_at);
  `);
}

// Helper to convert topic name to slug
function topicToSlug(topic: string): string {
  return topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

// Register resources handler
server.resource(
  "Knowledge Base",
  "knowledge://**",
  async (uri) => {
    if (!uri.href.startsWith("knowledge://")) {
      throw new Error("Invalid resource URI");
    }
    
    // Parse the URI
    const parts = uri.href.replace("knowledge://", "").split("/");
    let content;
    
    if (parts.length === 1) {
      // Top-level resource (no category)
      const slug = parts[0];
      content = await db.get(
        "SELECT content FROM topics WHERE slug = ? AND category_id IS NULL", 
        [slug]
      );
    } else {
      // Category/topic resource
      const categoryName = parts[0];
      const slug = parts[1];
      
      content = await db.get(`
        SELECT t.content 
        FROM topics t
        JOIN categories c ON t.category_id = c.id
        WHERE t.slug = ? AND c.name = ?
      `, [slug, categoryName]);
    }
    
    if (!content) {
      throw new Error(`Resource not found: ${uri.href}`);
    }
    
    return {
      contents: [{
        uri: uri.href,
        mimeType: "text/markdown",
        text: content.content
      }]
    };
  }
);

// Tool: lookUp - retrieve info about a specific topic
server.tool(
  "lookUp",
  "Look up information about a specific topic or technology from the knowledge vault. Use this when you need details about a particular tool, service, or concept.",
  {
    topic: z.string().describe("The name of the topic to look up"),
    category: z.string().optional().describe("Optional category the topic belongs to")
  },
  async ({ topic, category }) => {
    let result;
    const slug = topicToSlug(topic);
    
    if (category) {
      // Look up in specific category
      result = await db.get(`
        SELECT t.content 
        FROM topics t
        JOIN categories c ON t.category_id = c.id
        WHERE t.slug = ? AND c.name = ?
      `, [slug, category]);
    } else {
      // Try to find the topic in any category or with no category
      result = await db.get(`
        SELECT t.content 
        FROM topics t
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.slug = ?
        LIMIT 1
      `, [slug]);
    }
    
    if (!result) {
      return {
        content: [
          {
            type: "text",
            text: `No information found for topic "${topic}"${category ? ` in category "${category}"` : ""}`
          }
        ],
        isError: true
      };
    }
    
    return {
      content: [
        {
          type: "text",
          text: result.content
        }
      ]
    };
  }
);

// Tool: search - find topics containing specific terms
server.tool(
  "search",
  "Search across all topics in the knowledge vault containing specific terms. Use this when you want to find information related to keywords or concepts.",
  {
    query: z.string().describe("Search terms to find in topics"),
    category: z.string().optional().describe("Optional category to search within")
  },
  async ({ query, category }) => {
    const searchTerms = query.split(/\s+/).map(term => `%${term}%`);
    let sql = `
      SELECT t.name as topic_name, t.slug as topic_slug, t.content, 
             c.name as category_name
      FROM topics t
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE 
    `;
    
    // Build the search conditions for each term
    const searchConditions = searchTerms.map(() => 
      "(t.name LIKE ? OR t.content LIKE ?)"
    ).join(" AND ");
    
    sql += searchConditions;
    
    // Add category filter if provided
    if (category) {
      sql += " AND c.name = ?";
    }
    
    sql += " LIMIT 20"; // Limit results
    
    // Build the parameters array
    const params = [];
    for (const term of searchTerms) {
      params.push(term, term); // Two parameters per term (name and content)
    }
    
    if (category) {
      params.push(category);
    }
    
    const results = await db.all(sql, params);
    
    if (results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No results found for query "${query}"${category ? ` in category "${category}"` : ""}`
          }
        ]
      };
    }
    
    const resultsText = results.map(result => {
      const topicPath = result.category_name 
        ? `${result.category_name}/${result.topic_name}` 
        : result.topic_name;
      
      // Get a snippet of the content (first 200 chars)
      const snippet = result.content.substring(0, 200) + 
                     (result.content.length > 200 ? '...' : '');
      
      return `## ${result.topic_name}\nPath: ${topicPath}\n\n${snippet}`;
    }).join('\n\n---\n\n');
    
    return {
      content: [
        {
          type: "text",
          text: `# Search Results for "${query}"\n\nFound ${results.length} results:\n\n${resultsText}`
        }
      ]
    };
  }
);

// Tool: update - add or update information about a topic
server.tool(
  "update",
  "Add new information or update existing information about a topic in the knowledge vault. Use this to store important details about technologies, services, or concepts for future reference.",
  {
    topic: z.string().describe("The name of the topic to update"),
    content: z.string().describe("The markdown content to store"),
    category: z.string().optional().describe("Optional category to place the topic in"),
    user: z.string().optional().describe("User making the change"),
    comment: z.string().optional().describe("Comment about the change")
  },
  async ({ topic, content, category, user = 'system', comment }) => {
    const slug = topicToSlug(topic);
    let categoryId = null;
    
    if (category) {
      // Get or create the category
      const existingCategory = await db.get(
        "SELECT id FROM categories WHERE name = ?", 
        [category]
      );
      
      if (existingCategory) {
        categoryId = existingCategory.id;
      } else {
        const result = await db.run(
          "INSERT INTO categories (name) VALUES (?)", 
          [category]
        );
        categoryId = result.lastID;
      }
    }
    
    // Check if topic exists
    const existingTopic = await db.get(
      "SELECT id, content FROM topics WHERE slug = ? AND category_id IS ?", 
      [slug, categoryId]
    );
    
    if (existingTopic) {
      // Add current content to history before updating
      await db.run(
        "INSERT INTO topic_history (topic_id, content, changed_by, change_comment) VALUES (?, ?, ?, ?)",
        [existingTopic.id, existingTopic.content, user, comment || 'Update via API']
      );
      
      // Update existing topic
      await db.run(
        "UPDATE topics SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [content, existingTopic.id]
      );
    } else {
      // Create new topic
      const result = await db.run(
        "INSERT INTO topics (name, slug, category_id, content) VALUES (?, ?, ?, ?)",
        [topic, slug, categoryId, content]
      );
      
      // Add initial version to history
      await db.run(
        "INSERT INTO topic_history (topic_id, content, changed_by, change_comment) VALUES (?, ?, ?, ?)",
        [result.lastID, content, user, comment || 'Initial creation']
      );
    }
    
    return {
      content: [
        {
          type: "text",
          text: `Successfully updated information for "${topic}"${category ? ` in category "${category}"` : ""}`
        }
      ]
    };
  }
);

// Tool: list - list all available topics
server.tool(
  "list",
  "List all available topics in the knowledge vault. Use this when you need to see a complete list of all topics or categories.",
  {
    category: z.string().optional().describe("Optional category to list topics from")
  },
  async ({ category }) => {
    interface ResultMap {
      [key: string]: string[];
    }
    
    const results: ResultMap = {};
    
    if (category) {
      // List topics in specific category
      const topics = await db.all(`
        SELECT t.name 
        FROM topics t
        JOIN categories c ON t.category_id = c.id
        WHERE c.name = ?
        ORDER BY t.name
      `, [category]);
      
      if (topics.length > 0) {
        results[category] = topics.map(t => t.name);
      }
    } else {
      // List topics by category
      
      // First get uncategorized topics
      const uncategorizedTopics = await db.all(`
        SELECT name FROM topics WHERE category_id IS NULL ORDER BY name
      `);
      
      if (uncategorizedTopics.length > 0) {
        results["(No category)"] = uncategorizedTopics.map(t => t.name);
      }
      
      // Then get topics by category
      const categories = await db.all(`
        SELECT c.name as category_name, t.name as topic_name
        FROM topics t
        JOIN categories c ON t.category_id = c.id
        ORDER BY c.name, t.name
      `);
      
      // Group by category
      for (const row of categories) {
        if (!results[row.category_name]) {
          results[row.category_name] = [];
        }
        results[row.category_name].push(row.topic_name);
      }
    }
    
    // Format the results
    let resultText = "# Available Topics\n\n";
    
    for (const [categoryName, topics] of Object.entries(results)) {
      resultText += `## ${categoryName}\n\n`;
      for (const topic of topics) {
        resultText += `- ${topic}\n`;
      }
      resultText += "\n";
    }
    
    if (Object.keys(results).length === 0) {
      resultText += "No topics found.";
    }
    
    return {
      content: [
        {
          type: "text",
          text: resultText
        }
      ]
    };
  }
);

// Tool: createRelation - create or update relationships between topics
server.tool(
  "createRelation",
  "Create or update a relationship between two knowledge topics.",
  {
    sourceTopic: z.string().describe("The name of the source topic"),
    targetTopic: z.string().describe("The name of the target topic"),
    relationType: z.string().describe("The type of relationship (e.g., 'similar', 'alternative', 'complements')"),
    strength: z.number().min(0).max(1).default(0.5).optional().describe("Relationship strength from 0 to 1")
  },
  async ({ sourceTopic, targetTopic, relationType, strength = 0.5 }) => {
    // Get topic IDs
    const sourceSlug = topicToSlug(sourceTopic);
    const targetSlug = topicToSlug(targetTopic);
    
    const source = await db.get("SELECT id FROM topics WHERE slug = ?", [sourceSlug]);
    const target = await db.get("SELECT id FROM topics WHERE slug = ?", [targetSlug]);
    
    if (!source || !target) {
      return {
        content: [{ type: "text", text: "One or both topics not found." }],
        isError: true
      };
    }
    
    // Create or update relation
    await db.run(`
      INSERT INTO topic_relations (source_id, target_id, relationship_type, relationship_strength)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (source_id, target_id, relationship_type) 
      DO UPDATE SET relationship_strength = excluded.relationship_strength
    `, [source.id, target.id, relationType, strength]);
    
    return {
      content: [
        {
          type: "text",
          text: `Relationship created: "${sourceTopic}" ${relationType} "${targetTopic}" (strength: ${strength})`
        }
      ]
    };
  }
);

// Tool: getRelated - find topics related to a specific topic
server.tool(
  "getRelated",
  "Find topics related to a specific topic in the knowledge vault.",
  {
    topic: z.string().describe("The name of the topic to find relations for"),
    relationTypes: z.array(z.string()).optional().describe("Optional filter for relationship types")
  },
  async ({ topic, relationTypes }) => {
    const slug = topicToSlug(topic);
    
    let sql = `
      SELECT 
        t2.name as related_topic, 
        c.name as category,
        r.relationship_type, 
        r.relationship_strength
      FROM topic_relations r
      JOIN topics t1 ON r.source_id = t1.id
      JOIN topics t2 ON r.target_id = t2.id
      LEFT JOIN categories c ON t2.category_id = c.id
      WHERE t1.slug = ?
    `;
    
    const params = [slug];
    
    if (relationTypes && relationTypes.length > 0) {
      sql += ` AND r.relationship_type IN (${relationTypes.map(() => '?').join(',')})`;
      params.push(...relationTypes);
    }
    
    sql += " ORDER BY r.relationship_strength DESC";
    
    const relations = await db.all(sql, params);
    
    if (relations.length === 0) {
      return {
        content: [
          { type: "text", text: `No related topics found for "${topic}".` }
        ]
      };
    }
    
    const formattedRelations = relations.map(r => {
      const categoryText = r.category ? ` (in ${r.category})` : '';
      return `- **${r.related_topic}**${categoryText}: ${r.relationship_type} (strength: ${(r.relationship_strength * 100).toFixed(0)}%)`;
    }).join('\n');
    
    return {
      content: [
        {
          type: "text",
          text: `# Topics Related to "${topic}"\n\n${formattedRelations}`
        }
      ]
    };
  }
);

// Tool: viewHistory - view the version history of a topic
server.tool(
  "viewHistory",
  "View the version history of a topic in the knowledge vault.",
  {
    topic: z.string().describe("The name of the topic to view history for"),
    limit: z.number().min(1).max(50).default(10).optional().describe("Maximum number of versions to show")
  },
  async ({ topic, limit = 10 }) => {
    const slug = topicToSlug(topic);
    
    const history = await db.all(`
      SELECT 
        h.changed_at, 
        h.changed_by,
        h.change_comment,
        LENGTH(h.content) as content_length,
        t.name as topic_name,
        c.name as category_name
      FROM topic_history h
      JOIN topics t ON h.topic_id = t.id
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.slug = ?
      ORDER BY h.changed_at DESC
      LIMIT ?
    `, [slug, limit]);
    
    if (history.length === 0) {
      return {
        content: [
          { type: "text", text: `No history found for topic "${topic}".` }
        ]
      };
    }
    
    const topicInfo = history[0];
    const categoryText = topicInfo.category_name ? ` (in ${topicInfo.category_name})` : '';
    
    const versions = history.map((entry, index) => {
      const timestamp = new Date(entry.changed_at).toLocaleString();
      return `### Version ${history.length - index}
- **Date:** ${timestamp}
- **Editor:** ${entry.changed_by}
- **Comment:** ${entry.change_comment || 'No comment'}
- **Content Size:** ${entry.content_length} characters`;
    }).join('\n\n');
    
    return {
      content: [
        {
          type: "text",
          text: `# Version History for "${topicInfo.topic_name}"${categoryText}\n\n${versions}`
        }
      ]
    };
  }
);

// Start the server
async function main() {
  try {
    // Initialize the database
    await initializeDb();
    
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Knowledge Vault MCP Server running");
  } catch (error) {
    console.error("Error starting server:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});