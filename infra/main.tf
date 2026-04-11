terraform {
  required_version = ">= 1.5"

  required_providers {
    render = {
      source  = "render-oss/render"
      version = "~> 1.0"
    }
  }
}

provider "render" {
  # Set RENDER_API_KEY environment variable or use:
  # api_key = var.render_api_key
}

# ──────────────────────────────────────────────────────────
# Environment Group — shared secrets across services
# ──────────────────────────────────────────────────────────

resource "render_env_group" "accra" {
  name = "accra-env"

  env_vars = {
    NODE_ENV = { value = "production" }
  }

  secret_files = {}
}

# ──────────────────────────────────────────────────────────
# Web Service — accra API server
# ──────────────────────────────────────────────────────────

resource "render_web_service" "accra" {
  name   = var.service_name
  plan   = var.plan
  region = var.region

  runtime_source = {
    native_runtime = {
      auto_deploy   = true
      branch        = var.branch
      build_command  = "npm install"
      build_filter = {
        paths         = ["accra/**"]
        ignored_paths = ["accra/scripts/**", "accra/README.md"]
      }
      repo_url      = var.repo_url
      root_dir      = "accra"
      runtime       = "node"
    }
  }

  start_command    = "npm start"
  health_check_path = "/health"
  num_instances    = var.num_instances

  # Link the shared environment group
  env_vars = merge(
    {
      REDIS_HOST = {
        value = var.redis_host
      }
      REDIS_PORT = {
        value = tostring(var.redis_port)
      }
      REDIS_PASSWORD = {
        value = sensitive(var.redis_password)
      }
      JWT_SECRET = {
        value = sensitive(var.jwt_secret)
      }
      GOOGLE_CLIENT_ID = {
        value = var.google_client_id
      }
      GOOGLE_CLIENT_SECRET = {
        value = sensitive(var.google_client_secret)
      }
      OAUTH_REDIRECT_URI = {
        value = var.oauth_redirect_uri != "" ? var.oauth_redirect_uri : "https://${var.service_name}.onrender.com/api/auth/callback"
      }
      REQUIRE_AUTH = {
        value = var.require_auth ? "true" : "false"
      }
      SLACK_WEBHOOK_URL = {
        value = var.slack_webhook_url
      }
    },
  )

  notification_override = {
    preview_notifications_enabled = "false"
  }
}

# ──────────────────────────────────────────────────────────
# Persistent Disk (optional) — for resume blob storage
# ──────────────────────────────────────────────────────────

resource "render_disk" "resume_storage" {
  count = var.enable_disk ? 1 : 0

  name       = "accra-data"
  size_gb    = var.disk_size_gb
  mount_path = "/data"
  service_id = render_web_service.accra.id
}
