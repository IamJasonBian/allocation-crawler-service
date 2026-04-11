# ──────────────────────────────────────────────────────────
# Service config
# ──────────────────────────────────────────────────────────

variable "service_name" {
  description = "Name of the Render web service"
  type        = string
  default     = "accra"
}

variable "repo_url" {
  description = "GitHub repository URL"
  type        = string
  default     = "https://github.com/IamJasonBian/allocation-crawler-service"
}

variable "branch" {
  description = "Git branch to deploy"
  type        = string
  default     = "main"
}

variable "plan" {
  description = "Render plan (free, starter, standard, pro, etc.)"
  type        = string
  default     = "starter"
}

variable "region" {
  description = "Render region (oregon, ohio, virginia, frankfurt, singapore)"
  type        = string
  default     = "oregon"
}

variable "num_instances" {
  description = "Number of service instances"
  type        = number
  default     = 1
}

# ──────────────────────────────────────────────────────────
# Redis
# ──────────────────────────────────────────────────────────

variable "redis_host" {
  description = "Redis host"
  type        = string
}

variable "redis_port" {
  description = "Redis port"
  type        = number
  default     = 6379
}

variable "redis_password" {
  description = "Redis password"
  type        = string
  sensitive   = true
}

# ──────────────────────────────────────────────────────────
# OAuth / Auth
# ──────────────────────────────────────────────────────────

variable "jwt_secret" {
  description = "HMAC secret for JWT signing (generate with: openssl rand -hex 32)"
  type        = string
  sensitive   = true
}

variable "google_client_id" {
  description = "Google OAuth client ID"
  type        = string
  default     = ""
}

variable "google_client_secret" {
  description = "Google OAuth client secret"
  type        = string
  sensitive   = true
  default     = ""
}

variable "oauth_redirect_uri" {
  description = "OAuth redirect URI (defaults to https://<service_name>.onrender.com/api/auth/callback)"
  type        = string
  default     = ""
}

variable "require_auth" {
  description = "Enforce JWT authentication on all endpoints"
  type        = bool
  default     = false
}

# ──────────────────────────────────────────────────────────
# Integrations
# ──────────────────────────────────────────────────────────

variable "slack_webhook_url" {
  description = "Slack webhook URL for job discovery notifications"
  type        = string
  default     = ""
}

# ──────────────────────────────────────────────────────────
# Storage
# ──────────────────────────────────────────────────────────

variable "enable_disk" {
  description = "Attach a persistent disk for resume blob storage"
  type        = bool
  default     = false
}

variable "disk_size_gb" {
  description = "Persistent disk size in GB"
  type        = number
  default     = 1
}
