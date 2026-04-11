output "service_url" {
  description = "Public URL of the deployed service"
  value       = "https://${render_web_service.accra.name}.onrender.com"
}

output "service_id" {
  description = "Render service ID"
  value       = render_web_service.accra.id
}

output "health_check_url" {
  description = "Health check endpoint"
  value       = "https://${render_web_service.accra.name}.onrender.com/health"
}

output "oauth_callback_url" {
  description = "OAuth callback URL (add to Google Cloud Console)"
  value       = "https://${render_web_service.accra.name}.onrender.com/api/auth/callback"
}

output "mcp_endpoint" {
  description = "MCP server endpoint for Claude Desktop"
  value       = "https://${render_web_service.accra.name}.onrender.com/api/mcp"
}
