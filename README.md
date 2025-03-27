# Knowledge Vault MCP 🧠

A powerful knowledge management system that allows AI models to store, retrieve, and manage information through the Model Context Protocol (MCP). Think of it as a second brain for your AI assistants! 🤖

## Overview 🌟

Knowledge Vault MCP is a specialized MCP server that provides structured storage and retrieval of knowledge in a format that's easily accessible to both humans and AI models. It serves three key purposes:

1. **Personal Context** 👤
   - Store personal information and preferences
   - Example: "Users name is Stu Mason, he's 40 years old and lives in Folkestone, UK"
   - Example: "Stu prefers TypeScript over JavaScript for large projects"

2. **Project Knowledge** 📚
   - Maintain important project-specific information
   - Example: "The auth-service uses JWT tokens with a 24h expiry"
   - Example: "We chose MongoDB over PostgreSQL because of the flexible schema requirements"

3. **Current Information** 🔄
   - Keep AI models up-to-date with post-training-cutoff information
   - Example: "Lovable.dev is a new AI-powered platform launched in 2024"
   - Example: "Next.js 15 is the latest version and has the following breaking changes:..."

The system organizes information into categories and topics, making it simple to maintain and access a growing knowledge base.

## Quick Start 🚀

### Installation

```bash
# Clone the repository
git clone https://github.com/stumason/knowledge-vault.git
cd knowledge-vault

# Install dependencies
npm install

# Build the project
npm run build
```

### Configuration 🛠️

1. Add the Knowledge Vault to your MCP configuration:

```json
{
  "mcpServers": {
    "knowledge-vault": {
      "command": "node",
      "args": [
        "/path/to/knowledge-vault/build/index.js"
      ],
      "env": {
        "DB_PATH": "/path/to/knowledge-vault/knowledge.db"
      }
    }
  }
}
```

2. Restart your MCP-enabled application (like Claude Desktop) to load the new configuration.

## Features ✨

- **Organized Knowledge Structure** 📂
  - Category-based organization
  - Topic-based content management
  - Markdown-formatted content support

- **Powerful Search Capabilities** 🔍
  - Full-text search across all topics
  - Category-specific searches
  - Semantic search support

- **Easy Content Management** ✏️
  - Add new topics
  - Update existing content
  - Organize content into categories
  - List all available topics

- **Topic Relationships** 🔗
  - Create relationships between topics
  - Define relationship types (e.g., similar, alternative, complements)
  - Specify relationship strengths
  - View related topics and their connections

- **Version History** 📜
  - Track changes to topics over time
  - Record who made each change
  - Store change comments and timestamps
  - View complete version history

- **Import/Export** 💾
  - Export entire knowledge base or specific categories
  - Support for JSON and Markdown export formats
  - Import from JSON exports
  - Selective import with overwrite control

## Usage Examples 💡

### Searching Content 🔍

```javascript
// Search for all AI-related topics
mcp.search("AI tools and frameworks")
```

### Looking Up Topics 📖

```javascript
// Get detailed information about a specific topic
mcp.lookUp("Next.js 15")
```

### Managing Relationships 🔗

```javascript
// Create a relationship between topics
mcp.createRelation({
  sourceTopic: "TypeScript",
  targetTopic: "JavaScript",
  relationType: "similar",
  strength: 0.8
})

// Find related topics
mcp.getRelated({
  topic: "TypeScript",
  relationTypes: ["similar", "alternative"]
})
```

### Exporting and Importing 💾

```javascript
// Export entire knowledge base to JSON file
mcp.exportVault({
  format: "json",
  exportPath: "/path/to/exports/knowledge.json"
})

// Export specific category to Markdown file
mcp.exportVault({
  format: "markdown",
  category: "Development",
  exportPath: "/path/to/exports/development.md"
})

// Export without saving to file (returns content directly)
mcp.exportVault({
  format: "json"
})

// Import from JSON file
mcp.importVault({
  importPath: "/path/to/exports/knowledge.json",
  format: "json",
  overwrite: false
})

// Import directly from data string
mcp.importVault({
  data: jsonString,
  format: "json",
  overwrite: false
})
```

### Tracking History 📜

```javascript
// Update a topic with history tracking
mcp.update({
  topic: "Project Conventions",
  category: "Development",
  content: "# Git Commit Standards\n\nWe use conventional commits...",
  user: "stuart",
  comment: "Updated commit standards"
})

// View topic history
mcp.viewHistory({
  topic: "Project Conventions",
  limit: 10  // Show last 10 versions
})
```

### Updating Content ✏️

```javascript
// Add or update a topic
mcp.update({
  topic: "Project Conventions",
  category: "Development",
  content: "# Git Commit Standards\n\nWe use conventional commits..."
})
```

## Integration 🔌

This Knowledge Vault is built on the Model Context Protocol (MCP), allowing seamless integration with AI models and applications that support the MCP standard. For more information about MCP, see the [MCP Specification](https://spec.modelcontextprotocol.io/).

## Development Guide 🛠️

### Adding New Tools

To add a new tool to the Knowledge Vault, follow these steps:

1. **Add Database Schema** (if needed):
   ```sql
   // In the initializeDb() function:
   await db.exec(`
     CREATE TABLE IF NOT EXISTS your_table (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       // ... other fields
       FOREIGN KEY (...) REFERENCES ... (...)
     );
     
     // Add any necessary indexes
     CREATE INDEX IF NOT EXISTS idx_your_table_field ON your_table (field);
   `);
   ```

2. **Register the Tool**:

   ```typescript
   server.tool(
     "toolName",                    // Tool name
     "Tool description...",         // Human-readable description
     {
       // Zod schema for parameters
       param1: z.string().describe("Parameter description"),
       param2: z.number().optional().describe("Optional parameter description")
     },
     async ({ param1, param2 }) => {
       // Tool implementation
       const result = await db.all(`
         SELECT ... FROM ...
         WHERE ... = ?
       `, [param1]);
       
       return {
         content: [{
           type: "text",
           text: `Formatted result...`
         }]
       };
     }
   );
   ```

3. **Update README**:
   - Add tool to Features section
   - Add usage example
   - Update any relevant documentation

### Tool Implementation Best Practices

1. **Database Operations**:
   - Use parameterized queries to prevent SQL injection
   - Add appropriate indexes for query performance
   - Handle foreign key relationships properly
   - Consider adding constraints where appropriate

2. **Error Handling**:
   ```typescript
   if (!result) {
     return {
       content: [{ 
         type: "text", 
         text: "Error message" 
       }],
       isError: true
     };
   }
   ```

3. **Response Formatting**:
   - Use markdown for text responses
   - Structure complex data clearly
   - Include relevant metadata
   - Consider adding timestamps for time-sensitive data

4. **Parameter Validation**:
   - Use Zod schemas for type safety
   - Add descriptive parameter descriptions
   - Make parameters optional when appropriate
   - Set sensible default values

### Testing New Tools

1. Basic functionality:

   ```typescript
   // Create/update content
   await toolName({
     param1: "test value",
     param2: 123
   });
   
   // Verify results
   const result = await verificationTool({
     param: "test value"
   });
   ```

2. Edge cases to consider:
   - Empty/null values
   - Invalid parameters
   - Missing optional parameters
   - Maximum value sizes
   - Foreign key constraints

## Contributing 🤝

To contribute to the Knowledge Vault:

1. Create new topics with clear, well-structured content
2. Use markdown formatting for consistency
3. Organize content into appropriate categories
4. Include relevant metadata and tags

### Best Practices 💫

- Keep topics focused and concise
- Use descriptive titles
- Include examples where relevant
- Update outdated information promptly
- Cross-reference related topics

## License 📄

MIT

## Support 💪

If you encounter any issues or have questions, please check the [Issues](https://github.com/stumason/knowledge-vault/issues) page

---

Made with ❤️ by [Stu Mason](https://github.com/stumason) and AI.
