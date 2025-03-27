# Knowledge Vault MCP 🧠

A powerful knowledge management system that allows AI models to store, retrieve, and manage information through the Model Context Protocol (MCP). Think of it as a second brain for your AI assistants! 🤖

## Overview 🌟

Knowledge Vault MCP is a specialized MCP server that provides structured storage and retrieval of knowledge in a format that's easily accessible to both humans and AI models. It serves three key purposes:

1. **Personal Context** 👤
   - Store personal information and preferences
   - Example: "Stuart prefers TypeScript over JavaScript for large projects"
   - Example: "Stuart's GitHub username is stuartmason"

2. **Project Knowledge** 📚
   - Maintain important project-specific information
   - Example: "The auth-service uses JWT tokens with a 24h expiry"
   - Example: "We chose MongoDB over PostgreSQL because of the flexible schema requirements"

3. **Current Information** 🔄
   - Keep AI models up-to-date with post-training-cutoff information
   - Example: "Lovable.dev is a new AI-powered platform launched in 2024"
   - Example: "Next.js 14 introduced the partial prerendering feature"

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
