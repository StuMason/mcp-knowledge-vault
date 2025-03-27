import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

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
      content_type TEXT DEFAULT 'markdown',
      is_inactive BOOLEAN DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories (id),
      UNIQUE (slug, category_id)
    );

    CREATE INDEX IF NOT EXISTS idx_topics_slug ON topics (slug);
    CREATE INDEX IF NOT EXISTS idx_topics_category ON topics (category_id);

    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      data BLOB NOT NULL,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (topic_id) REFERENCES topics (id)
    );

    CREATE INDEX IF NOT EXISTS idx_attachments_topic ON attachments (topic_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_mime ON attachments (mime_type);

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

    CREATE TABLE IF NOT EXISTS exports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL
    );
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

// Helper to find cross-references in content
async function findCrossReferences(content: string): Promise<{name: string, confidence: number}[]> {
  // Get all topics
  const allTopics = await db.all("SELECT name FROM topics");
  const topicNames = allTopics.map(t => t.name);
  
  // Sort by length (descending) to prioritize longer names
  topicNames.sort((a, b) => b.length - a.length);
  
  // Find mentions
  const mentions = new Map<string, number>();
  
  // First look for Markdown links
  const markdownLinkRegex = /\[([^\]]+)\]\([^)]+\)/g;
  let match;
  while ((match = markdownLinkRegex.exec(content)) !== null) {
    const linkText = match[1];
    const exactMatch = topicNames.find(name => name.toLowerCase() === linkText.toLowerCase());
    if (exactMatch) {
      mentions.set(exactMatch, 1.0); // Explicit links get full confidence
    }
  }
  
  // Then look for plain text mentions
  for (const name of topicNames) {
    // Exact match with word boundaries
    const exactRegex = new RegExp(`\\b${name}\\b`, 'gi');
    if (exactRegex.test(content)) {
      mentions.set(name, 0.9); // High confidence for exact matches
      continue;
    }
    
    // Fuzzy match for slight variations (simple implementation)
    const fuzzyRegex = new RegExp(name.split('').join('\\s*'), 'gi');
    if (fuzzyRegex.test(content)) {
      mentions.set(name, 0.7); // Lower confidence for fuzzy matches
    }
  }
  
  return Array.from(mentions.entries()).map(([name, confidence]) => ({name, confidence}));
}

// Tool: update - add or update information about a topic
server.tool(
  "update",
  "Add new information or update existing information about a topic in the knowledge vault. Use this to store important details about technologies, services, or concepts for future reference.",
  {
    topic: z.string().describe("The name of the topic to update"),
    content: z.string().describe("The content to store"),
    contentType: z.string().default('markdown').optional().describe("Content type (e.g., 'markdown', 'html', 'text')"),
    category: z.string().optional().describe("Optional category to place the topic in"),
    user: z.string().optional().describe("User making the change"),
    comment: z.string().optional().describe("Comment about the change"),
    detectReferences: z.boolean().default(true).optional().describe("Whether to automatically detect and create references to other topics")
  },
  async ({ topic, content, contentType = 'markdown', category, user = 'system', comment, detectReferences = true }) => {
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
      "SELECT id, content, content_type FROM topics WHERE slug = ? AND category_id IS ?", 
      [slug, categoryId]
    );
    
    let topicId: number;
    
    if (existingTopic) {
      topicId = existingTopic.id;
      
      // Add current content to history before updating
      await db.run(
        "INSERT INTO topic_history (topic_id, content, changed_by, change_comment) VALUES (?, ?, ?, ?)",
        [topicId, existingTopic.content, user, comment || 'Update via API']
      );
      
      // Update existing topic
      await db.run(
        "UPDATE topics SET content = ?, content_type = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [content, contentType, topicId]
      );
    } else {
      // Create new topic
      const result = await db.run(
        "INSERT INTO topics (name, slug, category_id, content, content_type) VALUES (?, ?, ?, ?, ?)",
        [topic, slug, categoryId, content, contentType]
      );
      
      if (!result.lastID) {
        throw new Error("Failed to create new topic - no ID returned");
      }
      
      topicId = result.lastID;
      
      // Add initial version to history
      await db.run(
        "INSERT INTO topic_history (topic_id, content, changed_by, change_comment) VALUES (?, ?, ?, ?)",
        [topicId, content, user, comment || 'Initial creation']
      );
    }
    
    // Handle cross-references if enabled
    if (detectReferences) {
      const mentions = await findCrossReferences(content);
      
      for (const {name, confidence} of mentions) {
        const mentionedSlug = topicToSlug(name);
        const mentionedTopic = await db.get("SELECT id FROM topics WHERE slug = ?", [mentionedSlug]);
        
        if (mentionedTopic && mentionedTopic.id !== topicId) {
          // Create bidirectional reference relations with different strengths
          await db.run(`
            INSERT INTO topic_relations (source_id, target_id, relationship_type, relationship_strength)
            VALUES (?, ?, 'references', ?)
            ON CONFLICT (source_id, target_id, relationship_type) 
            DO UPDATE SET relationship_strength = excluded.relationship_strength
          `, [topicId, mentionedTopic.id, confidence]);
          
          // Create weaker reverse reference
          await db.run(`
            INSERT INTO topic_relations (source_id, target_id, relationship_type, relationship_strength)
            VALUES (?, ?, 'referenced_by', ?)
            ON CONFLICT (source_id, target_id, relationship_type) 
            DO UPDATE SET relationship_strength = excluded.relationship_strength
          `, [mentionedTopic.id, topicId, confidence * 0.7]);
        }
      }
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
  "listTopics",
  "List all available topics in the knowledge vault. Use this when you need to see a complete list of all topics or categories.",
  {
    category: z.string().optional().describe("Optional category to list topics from"),
    includeInactive: z.boolean().default(false).optional().describe("Whether to include inactive topics in the listing")
  },
  async ({ category, includeInactive = false }) => {
    interface ResultMap {
      [key: string]: string[];
    }
    
    const results: ResultMap = {};
    
    if (category) {
      // List topics in specific category
      const topics = await db.all(`
        SELECT t.name, t.is_inactive
        FROM topics t
        JOIN categories c ON t.category_id = c.id
        WHERE c.name = ? ${!includeInactive ? 'AND t.is_inactive = 0' : ''}
        ORDER BY t.name
      `, [category]);
      
      if (topics.length > 0) {
        results[category] = topics.map(t => t.is_inactive ? `${t.name} (inactive)` : t.name);
      }
    } else {
      // List topics by category
      
      // First get uncategorized topics
      const uncategorizedTopics = await db.all(`
        SELECT name, is_inactive 
        FROM topics 
        WHERE category_id IS NULL ${!includeInactive ? 'AND is_inactive = 0' : ''}
        ORDER BY name
      `);
      
      if (uncategorizedTopics.length > 0) {
        results["(No category)"] = uncategorizedTopics.map(t => 
          t.is_inactive ? `${t.name} (inactive)` : t.name
        );
      }
      
      // Then get topics by category
      const categories = await db.all(`
        SELECT 
          c.name as category_name, 
          t.name as topic_name,
          t.is_inactive
        FROM topics t
        JOIN categories c ON t.category_id = c.id
        ${!includeInactive ? 'WHERE t.is_inactive = 0' : ''}
        ORDER BY c.name, t.name
      `);
      
      // Group by category
      for (const row of categories) {
        if (!results[row.category_name]) {
          results[row.category_name] = [];
        }
        results[row.category_name].push(
          row.is_inactive ? `${row.topic_name} (inactive)` : row.topic_name
        );
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

// Tool: exportVault - export the knowledge vault
server.tool(
  "exportVault",
  "Export the entire knowledge vault or a specific category to a portable format.",
  {
    format: z.enum(["json", "markdown"]).default("json").describe("Export format"),
    category: z.string().optional().describe("Optional category to export"),
    exportPath: z.string().optional().describe("Optional file path to save the export. If not provided, returns content directly.")
  },
  async ({ format, category, exportPath }) => {
    // First get topics
    let topicSql = `
      SELECT 
        t.name as topic_name, 
        t.slug as topic_slug,
        t.content,
        c.name as category_name
      FROM topics t
      LEFT JOIN categories c ON t.category_id = c.id
    `;
    
    const params = [];
    if (category) {
      topicSql += " WHERE c.name = ?";
      params.push(category);
    }
    
    const topics = await db.all(topicSql, params);

    // Then get relationships for these topics
    const topicNames = topics.map(t => t.topic_name);
    const relationsSql = `
      SELECT 
        t1.name as source_topic,
        t2.name as target_topic,
        tr.relationship_type as relation_type,
        tr.relationship_strength as strength
      FROM topic_relations tr
      JOIN topics t1 ON tr.source_id = t1.id
      JOIN topics t2 ON tr.target_id = t2.id
      WHERE t1.name IN (${topicNames.map(() => '?').join(',')})
      OR t2.name IN (${topicNames.map(() => '?').join(',')})
    `;

    const relations = await db.all(relationsSql, [...topicNames, ...topicNames]);
    
    if (format === "json") {
      const exportData = {
        format: "knowledgevault-export-v1",
        date: new Date().toISOString(),
        topics: topics.map(t => ({
          name: t.topic_name,
          slug: t.topic_slug,
          category: t.category_name,
          content: t.content
        })),
        relations: relations.map(r => ({
          sourceTopic: r.source_topic,
          targetTopic: r.target_topic,
          relationType: r.relation_type,
          strength: r.strength
        }))
      };
      
      const content = JSON.stringify(exportData, null, 2);
      
      if (exportPath) {
        try {
          const fsPromises = await import('fs/promises');
          await fsPromises.mkdir(exportPath.split('/').slice(0, -1).join('/'), { recursive: true });
          await fsPromises.writeFile(exportPath, content);
          
          return {
            content: [
              {
                type: "text",
                text: `Export saved to: ${exportPath}`
              }
            ]
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to save export to file: ${error instanceof Error ? error.message : String(error)}\n\nExport content:\n${content}`
              }
            ],
            isError: true
          };
        }
      }
      
      return {
        content: [
          {
            type: "text",
            text: content
          }
        ]
      };
    } else if (format === "markdown") {
      // Group by category
      const byCategory: Record<string, any[]> = {};
      
      for (const topic of topics) {
        const cat = topic.category_name || "Uncategorized";
        if (!byCategory[cat]) {
          byCategory[cat] = [];
        }
        byCategory[cat].push(topic);
      }
      
      // Create markdown content
      let markdown = `# Knowledge Vault Export\n\nExported on ${new Date().toLocaleString()}\n\n`;
      
      // First output topics by category
      for (const [cat, catTopics] of Object.entries(byCategory)) {
        markdown += `## Category: ${cat}\n\n`;
        
        for (const topic of catTopics) {
          markdown += `### ${topic.topic_name}\n\n${topic.content}\n\n---\n\n`;
        }
      }

      // Then output relationships section if any exist
      if (relations.length > 0) {
        markdown += `## Topic Relationships\n\n`;
        for (const rel of relations) {
          markdown += `- ${rel.source_topic} → ${rel.target_topic} (${rel.relation_type}, strength: ${rel.strength})\n`;
        }
        markdown += '\n';
      }
      
      if (exportPath) {
        try {
          const fsPromises = await import('fs/promises');
          await fsPromises.mkdir(exportPath.split('/').slice(0, -1).join('/'), { recursive: true });
          await fsPromises.writeFile(exportPath, markdown);
          
          return {
            content: [
              {
                type: "text",
                text: `Export saved to: ${exportPath}`
              }
            ]
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to save export to file: ${error instanceof Error ? error.message : String(error)}\n\nExport content:\n${markdown}`
              }
            ],
            isError: true
          };
        }
      }
      
      return {
        content: [
          {
            type: "text",
            text: markdown
          }
        ]
      };
    }
    
    return {
      content: [
        {
          type: "text",
          text: "Unsupported export format."
        }
      ],
      isError: true
    };
  }
);

// Tool: importVault - import knowledge data
server.tool(
  "importVault",
  "Import knowledge data from an exported format.",
  {
    data: z.string().optional().describe("The exported data to import"),
    importPath: z.string().optional().describe("Optional file path to read the import data from"),
    format: z.enum(["json"]).default("json").describe("Format of the import data"),
    overwrite: z.boolean().default(false).optional().describe("Whether to overwrite existing topics")
  },
  async ({ data, importPath, format, overwrite = false }) => {
    let importData;
    
    if (!data && !importPath) {
      return {
        content: [
          {
            type: "text",
            text: "Either data or importPath must be provided."
          }
        ],
        isError: true
      };
    }

    if (format !== "json") {
      return {
        content: [
          {
            type: "text",
            text: "Currently only JSON format is supported for import."
          }
        ],
        isError: true
      };
    }
    
    try {
      if (importPath) {
        try {
          const fsPromises = await import('fs/promises');
          data = await fsPromises.readFile(importPath, 'utf-8');
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to read import file: ${error instanceof Error ? error.message : String(error)}`
              }
            ],
            isError: true
          };
        }
      }

      if (!data) {
        return {
          content: [
            {
              type: "text",
              text: "No import data provided."
            }
          ],
          isError: true
        };
      }
      
      importData = JSON.parse(data);
      
      if (importData.format !== "knowledgevault-export-v1") {
        return {
          content: [
            {
              type: "text",
              text: "Invalid import format. Expected 'knowledgevault-export-v1'."
            }
          ],
          isError: true
        };
      }
      
      let imported = 0;
      let skipped = 0;
      let relationsImported = 0;
      let relationsSkipped = 0;
      
      // First import all topics to ensure they exist
      for (const topic of importData.topics) {
        const existingTopic = await db.get(
          "SELECT id FROM topics WHERE slug = ?", 
          [topic.slug]
        );
        
        if (existingTopic && !overwrite) {
          skipped++;
          continue;
        }
        
        // Get or create category
        let categoryId = null;
        if (topic.category) {
          const category = await db.get(
            "SELECT id FROM categories WHERE name = ?", 
            [topic.category]
          );
          
          if (category) {
            categoryId = category.id;
          } else {
            const result = await db.run(
              "INSERT INTO categories (name) VALUES (?)", 
              [topic.category]
            );
            categoryId = result.lastID;
          }
        }
        
        if (existingTopic) {
          // Update
          await db.run(
            "UPDATE topics SET name = ?, content = ?, category_id = ? WHERE id = ?",
            [topic.name, topic.content, categoryId, existingTopic.id]
          );
        } else {
          // Insert
          await db.run(
            "INSERT INTO topics (name, slug, category_id, content) VALUES (?, ?, ?, ?)",
            [topic.name, topic.slug, categoryId, topic.content]
          );
        }
        
        imported++;
      }

      // Then import relationships if they exist
      if (importData.relations && Array.isArray(importData.relations)) {
        for (const relation of importData.relations) {
          // Get topic IDs
          const source = await db.get(
            "SELECT id FROM topics WHERE name = ?",
            [relation.sourceTopic]
          );
          const target = await db.get(
            "SELECT id FROM topics WHERE name = ?",
            [relation.targetTopic]
          );

          if (!source || !target) {
            relationsSkipped++;
            continue;
          }

          // Check if relation exists
          const existingRelation = await db.get(
            "SELECT id FROM topic_relations WHERE source_id = ? AND target_id = ? AND relationship_type = ?",
            [source.id, target.id, relation.relationType]
          );

          if (existingRelation && !overwrite) {
            relationsSkipped++;
            continue;
          }

          if (existingRelation) {
            // Update
            await db.run(
              "UPDATE topic_relations SET relationship_strength = ? WHERE id = ?",
              [relation.strength, existingRelation.id]
            );
          } else {
            // Insert
            await db.run(
              "INSERT INTO topic_relations (source_id, target_id, relationship_type, relationship_strength) VALUES (?, ?, ?, ?)",
              [source.id, target.id, relation.relationType, relation.strength]
            );
          }

          relationsImported++;
        }
      }
      
      return {
        content: [
          {
            type: "text",
            text: `Import complete:\n- Topics: ${imported} imported, ${skipped} skipped\n- Relations: ${relationsImported} imported, ${relationsSkipped} skipped`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Import failed: ${error instanceof Error ? error.message : String(error)}`
          }
        ],
        isError: true
      };
    }
  }
);

// Tool: addAttachment - add an attachment to a topic
server.tool(
  "addAttachment",
  "Add an attachment (image, PDF, etc.) to a topic in the knowledge vault.",
  {
    topic: z.string().describe("The name of the topic to attach file to"),
    fileName: z.string().describe("Name of the file to attach"),
    mimeType: z.string().describe("MIME type of the file"),
    filePath: z.string().describe("Path to the file to attach"),
    description: z.string().optional().describe("Optional description of the attachment")
  },
  async ({ topic, fileName, mimeType, filePath, description }) => {
    const slug = topicToSlug(topic);
    
    // Get topic ID
    const topicResult = await db.get(
      "SELECT id FROM topics WHERE slug = ?",
      [slug]
    );
    
    if (!topicResult) {
      return {
        content: [{ 
          type: "text", 
          text: `Topic "${topic}" not found.` 
        }],
        isError: true
      };
    }

    try {
      // Read the file
      const fsPromises = await import('fs/promises');
      const fileData = await fsPromises.readFile(filePath);
      
      // Add attachment
      await db.run(
        "INSERT INTO attachments (topic_id, file_name, mime_type, data, description) VALUES (?, ?, ?, ?, ?)",
        [topicResult.id, fileName, mimeType, fileData, description]
      );
      
      return {
        content: [
          {
            type: "text",
            text: `Successfully attached "${fileName}" to topic "${topic}"`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to add attachment: ${error instanceof Error ? error.message : String(error)}`
          }
        ],
        isError: true
      };
    }
  }
);

// Tool: getAttachments - list attachments for a topic
server.tool(
  "getAttachments",
  "List all attachments for a specific topic.",
  {
    topic: z.string().describe("The name of the topic to get attachments for")
  },
  async ({ topic }) => {
    const slug = topicToSlug(topic);
    
    const attachments = await db.all(`
      SELECT 
        a.file_name,
        a.mime_type,
        a.description,
        a.created_at,
        LENGTH(a.data) as size
      FROM attachments a
      JOIN topics t ON a.topic_id = t.id
      WHERE t.slug = ?
      ORDER BY a.created_at DESC
    `, [slug]);
    
    if (attachments.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No attachments found for topic "${topic}"`
          }
        ]
      };
    }
    
    const formattedAttachments = attachments.map(a => {
      const timestamp = new Date(a.created_at).toLocaleString();
      const sizeInKB = Math.round(a.size / 1024);
      return `- **${a.file_name}** (${a.mime_type}, ${sizeInKB}KB)
  Added: ${timestamp}
  ${a.description ? `Description: ${a.description}` : ''}`;
    }).join('\n\n');
    
    return {
      content: [
        {
          type: "text",
          text: `# Attachments for "${topic}"\n\n${formattedAttachments}`
        }
      ]
    };
  }
);

// Tool: getAttachment - retrieve a specific attachment
server.tool(
  "getAttachment",
  "Retrieve a specific attachment from a topic. ⚠️ WARNING: This tool returns non-text content (binary data) and will not work through the MCP Client, which only supports text-based content. Consider using direct API calls or alternative methods to retrieve attachments.",
  {
    topic: z.string().describe("The name of the topic containing the attachment"),
    fileName: z.string().describe("Name of the file to retrieve")
  },
  async ({ topic, fileName }) => {
    const slug = topicToSlug(topic);
    
    const attachment = await db.get(`
      SELECT 
        a.data,
        a.mime_type
      FROM attachments a
      JOIN topics t ON a.topic_id = t.id
      WHERE t.slug = ? AND a.file_name = ?
    `, [slug, fileName]);
    
    if (!attachment) {
      return {
        content: [
          {
            type: "text",
            text: `Attachment "${fileName}" not found in topic "${topic}"`
          }
        ],
        isError: true
      };
    }
    
    return {
      content: [
        {
          type: "image",
          mimeType: attachment.mime_type,
          data: attachment.data.toString('base64')
        }
      ]
    };
  }
);

// Tool: importFromURL - import content from a URL
server.tool(
  "importFromURL",
  "Import content from a URL into the knowledge vault.",
  {
    url: z.string().url().describe("The URL to import content from"),
    topic: z.string().describe("The name of the topic to create or update"),
    category: z.string().optional().describe("Optional category for the topic")
  },
  async ({ url, topic, category }) => {
    try {
      // Fetch the URL content
      const response = await fetch(url);
      if (!response.ok) {
        return {
          content: [{ type: "text", text: `Failed to fetch URL: ${response.statusText}` }],
          isError: true
        };
      }
      
      const html = await response.text();
      
      // Parse HTML with cheerio
      const $ = cheerio.load(html);
      
      // Extract key metadata
      const title = $('title').text().trim() || topic;
      const metaDescription = $('meta[name="description"]').attr('content')?.trim() || '';
      const author = $('meta[name="author"]').attr('content')?.trim() || '';
      const publishDate = $('meta[property="article:published_time"]').attr('content') || '';
      
      // Try to extract main content using common selectors
      let mainContent = '';
      const contentSelectors = [
        'article',
        'main',
        '[role="main"]',
        '.content',
        '.post-content',
        '.article-content',
        '#content'
      ];
      
      for (const selector of contentSelectors) {
        const element = $(selector).first();
        if (element.length) {
          // Remove unwanted elements
          element.find('script, style, nav, header, footer, .ads, .comments').remove();
          mainContent = element.text().trim();
          break;
        }
      }
      
      // If no main content found, try fallback to body
      if (!mainContent) {
        const body = $('body');
        body.find('script, style, nav, header, footer, .ads, .comments').remove();
        mainContent = body.text().trim();
      }
      
      // Clean up the content
      mainContent = mainContent
        .replace(/\s+/g, ' ')
        .replace(/\n\s*\n/g, '\n\n')
        .trim();
      
      // Format as markdown with metadata
      const markdown = `# ${title}

${metaDescription}

## Content

${mainContent}

## Metadata

- **Source:** [${url}](${url})
- **Author:** ${author || 'Not specified'}
- **Published:** ${publishDate ? new Date(publishDate).toLocaleString() : 'Not specified'}
- **Imported:** ${new Date().toISOString()}

*This content was automatically imported from ${url}*`;

      // Get or create category if specified
      let categoryId = null;
      if (category) {
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
      const slug = topicToSlug(topic);
      const existingTopic = await db.get(
        "SELECT id, content FROM topics WHERE slug = ? AND category_id IS ?", 
        [slug, categoryId]
      );
      
      if (existingTopic) {
        // Add current content to history
        await db.run(
          "INSERT INTO topic_history (topic_id, content, changed_by, change_comment) VALUES (?, ?, ?, ?)",
          [existingTopic.id, existingTopic.content, 'system', `Updated from ${url}`]
        );
        
        // Update existing topic
        await db.run(
          "UPDATE topics SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [markdown, existingTopic.id]
        );
      } else {
        // Create new topic
        const result = await db.run(
          "INSERT INTO topics (name, slug, category_id, content) VALUES (?, ?, ?, ?)",
          [topic, slug, categoryId, markdown]
        );
        
        // Add initial version to history
        await db.run(
          "INSERT INTO topic_history (topic_id, content, changed_by, change_comment) VALUES (?, ?, ?, ?)",
          [result.lastID, markdown, 'system', `Initial import from ${url}`]
        );
      }
      
      return {
        content: [
          {
            type: "text",
            text: `Successfully imported content from ${url} into topic "${topic}"${category ? ` in category "${category}"` : ""}`
          }
        ]
      };
      
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to import content: ${error instanceof Error ? error.message : String(error)}`
          }
        ],
        isError: true
      };
    }
  }
);

// GitHub API types
interface GitHubUser {
  login: string;
  html_url: string;
}

interface GitHubLicense {
  name: string;
}

interface GitHubRepo {
  name: string;
  description: string | null;
  owner: GitHubUser;
  stargazers_count: number;
  forks_count: number;
  subscribers_count: number;
  updated_at: string;
  language: string | null;
  license: GitHubLicense | null;
  topics: string[];
  open_issues_count: number;
  size: number;
  default_branch: string;
  html_url: string;
  homepage: string | null;
  has_wiki: boolean;
}

interface GitHubReadme {
  content: string;
}

// Tool: syncFromGitHub - sync GitHub repository information
server.tool(
  "syncFromGitHub",
  "Sync information from a GitHub repository into the knowledge vault.",
  {
    repo: z.string().describe("GitHub repository in format 'owner/repo'"),
    category: z.string().default("GitHub Projects").optional().describe("Category to store the information in"),
    token: z.string().optional().describe("Optional GitHub personal access token for private repos")
  },
  async ({ repo, category = "GitHub Projects", token }) => {
    try {
      const headers: Record<string, string> = {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Knowledge-Vault-MCP'
      };
      
      if (token) {
        headers['Authorization'] = `token ${token}`;
      }
      
      // Fetch repository information
      const repoResponse = await fetch(`https://api.github.com/repos/${repo}`, { headers });
      if (!repoResponse.ok) {
        return {
          content: [{ type: "text", text: `Failed to fetch repository: ${repoResponse.statusText}` }],
          isError: true
        };
      }
      
      const repoData = await repoResponse.json() as GitHubRepo;
      
      // Fetch README
      const readmeResponse = await fetch(`https://api.github.com/repos/${repo}/readme`, { headers });
      let readmeContent = '';
      
      if (readmeResponse.ok) {
        const readmeData = await readmeResponse.json() as GitHubReadme;
        readmeContent = Buffer.from(readmeData.content, 'base64').toString('utf-8');
      }
      
      // Format the content
      const markdown = `# ${repoData.name}

${repoData.description || ''}

## Repository Information

- **Owner:** [${repoData.owner.login}](${repoData.owner.html_url})
- **Stars:** ${repoData.stargazers_count.toLocaleString()}
- **Forks:** ${repoData.forks_count.toLocaleString()}
- **Watchers:** ${repoData.subscribers_count.toLocaleString()}
- **Last Updated:** ${new Date(repoData.updated_at).toLocaleString()}
- **Language:** ${repoData.language || 'Not specified'}
- **License:** ${repoData.license?.name || 'Not specified'}
- **Topics:** ${repoData.topics?.join(', ') || 'None'}

## Statistics

- **Open Issues:** ${repoData.open_issues_count}
- **Size:** ${(repoData.size / 1024).toFixed(2)} MB
- **Default Branch:** \`${repoData.default_branch}\`

## Links

- **Repository:** [${repoData.html_url}](${repoData.html_url})
- **Homepage:** ${repoData.homepage ? `[${repoData.homepage}](${repoData.homepage})` : 'Not specified'}
- **Wiki:** ${repoData.has_wiki ? `[Wiki](${repoData.html_url}/wiki)` : 'Not enabled'}

${readmeContent ? `## README\n\n${readmeContent}` : ''}

*Last synced: ${new Date().toISOString()}*`;

      // Get or create category
      let categoryId = null;
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
      
      // Check if topic exists
      const slug = topicToSlug(repoData.name);
      const existingTopic = await db.get(
        "SELECT id, content FROM topics WHERE slug = ? AND category_id IS ?", 
        [slug, categoryId]
      );
      
      if (existingTopic) {
        // Add current content to history
        await db.run(
          "INSERT INTO topic_history (topic_id, content, changed_by, change_comment) VALUES (?, ?, ?, ?)",
          [existingTopic.id, existingTopic.content, 'system', `Synced from GitHub`]
        );
        
        // Update existing topic
        await db.run(
          "UPDATE topics SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [markdown, existingTopic.id]
        );
      } else {
        // Create new topic
        const result = await db.run(
          "INSERT INTO topics (name, slug, category_id, content) VALUES (?, ?, ?, ?)",
          [repoData.name, slug, categoryId, markdown]
        );
        
        // Add initial version to history
        await db.run(
          "INSERT INTO topic_history (topic_id, content, changed_by, change_comment) VALUES (?, ?, ?, ?)",
          [result.lastID, markdown, 'system', `Initial sync from GitHub`]
        );
      }
      
      return {
        content: [
          {
            type: "text",
            text: `Successfully synced information from ${repo} into the knowledge vault.`
          }
        ]
      };
      
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to sync repository: ${error instanceof Error ? error.message : String(error)}`
          }
        ],
        isError: true
      };
    }
  }
);

// Tool: deleteTopic - permanently delete a topic
server.tool(
  "deleteTopic",
  "Permanently delete a topic and all its associated data (attachments, relationships, history).",
  {
    topic: z.string().describe("The name of the topic to delete"),
    confirm: z.boolean().describe("Confirmation flag to prevent accidental deletion")
  },
  async ({ topic, confirm }) => {
    if (!confirm) {
      return {
        content: [{ 
          type: "text", 
          text: "Please set confirm=true to confirm topic deletion. This action cannot be undone." 
        }],
        isError: true
      };
    }

    const slug = topicToSlug(topic);
    
    // Get topic ID
    const topicResult = await db.get(
      "SELECT id, name, category_id FROM topics WHERE slug = ?",
      [slug]
    );
    
    if (!topicResult) {
      return {
        content: [{ 
          type: "text", 
          text: `Topic "${topic}" not found.` 
        }],
        isError: true
      };
    }

    // Start a transaction
    await db.run('BEGIN TRANSACTION');

    try {
      // Delete attachments
      await db.run(
        "DELETE FROM attachments WHERE topic_id = ?",
        [topicResult.id]
      );

      // Delete relationships
      await db.run(
        "DELETE FROM topic_relations WHERE source_id = ? OR target_id = ?",
        [topicResult.id, topicResult.id]
      );

      // Delete history
      await db.run(
        "DELETE FROM topic_history WHERE topic_id = ?",
        [topicResult.id]
      );

      // Delete the topic
      await db.run(
        "DELETE FROM topics WHERE id = ?",
        [topicResult.id]
      );

      // Commit the transaction
      await db.run('COMMIT');

      return {
        content: [
          {
            type: "text",
            text: `Successfully deleted topic "${topic}" and all associated data.`
          }
        ]
      };
    } catch (error) {
      // Rollback on error
      await db.run('ROLLBACK');
      
      return {
        content: [
          {
            type: "text",
            text: `Failed to delete topic: ${error instanceof Error ? error.message : String(error)}`
          }
        ],
        isError: true
      };
    }
  }
);

// Tool: toggleTopicStatus - activate or inactivate a topic
server.tool(
  "toggleTopicStatus",
  "Toggle a topic's active/inactive status. Inactive topics are hidden from normal operations but can be reactivated later.",
  {
    topic: z.string().describe("The name of the topic to toggle status"),
    setInactive: z.boolean().describe("Whether to set the topic as inactive (true) or active (false)")
  },
  async ({ topic, setInactive }) => {
    const slug = topicToSlug(topic);
    
    // Get topic current status
    const topicResult = await db.get(
      "SELECT id, name, is_inactive FROM topics WHERE slug = ?",
      [slug]
    );
    
    if (!topicResult) {
      return {
        content: [{ 
          type: "text", 
          text: `Topic "${topic}" not found.` 
        }],
        isError: true
      };
    }

    // If status is already what we want, no need to update
    if (!!topicResult.is_inactive === setInactive) {
      const status = setInactive ? "inactive" : "active";
      return {
        content: [{ 
          type: "text", 
          text: `Topic "${topic}" is already ${status}.` 
        }]
      };
    }

    // Update the status
    await db.run(
      "UPDATE topics SET is_inactive = ? WHERE id = ?",
      [setInactive ? 1 : 0, topicResult.id]
    );

    const newStatus = setInactive ? "inactive" : "active";
    return {
      content: [
        {
          type: "text",
          text: `Successfully set topic "${topic}" as ${newStatus}.`
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