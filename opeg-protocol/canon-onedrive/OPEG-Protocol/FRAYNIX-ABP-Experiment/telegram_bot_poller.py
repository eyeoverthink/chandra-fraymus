"""
Telegram Bot Poller — Niles Bot
Polls @Smiles_Niles_Bot for new messages and dispatches to agent.
Runs every 30 minutes via scheduled task.
"""

import requests
import time
import json
import os
import sys
from datetime import datetime

# Load config
def load_config():
    """Load Telegram bot config from environment."""
    config = {}
    
    # Read from .env file
    env_path = r"C:\Users\eyeka\AppData\Local\hermes\.env"
    try:
        with open(env_path, "r") as f:
            for line in f:
                line = line.strip()
                if line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip("\"'")
                config[key] = value
    except Exception as e:
        print(f"Warning: Could not read .env: {e}")
    
    # Priority: environment variables > .env file
    return {
        "token": os.environ.get("TELEGRAM_BOT_TOKEN", config.get("TELEGRAM_BOT_TOKEN")),
        "chat_id": os.environ.get("TELEGRAM_CHAT_ID", config.get("TELEGRAM_CHAT_ID", "8035041944"))
    }


class TelegramBot:
    """Simple Telegram bot poller."""
    
    def __init__(self, config):
        self.token = config["token"]
        self.chat_id = config["chat_id"]
        self.base_url = f"https://api.telegram.org/bot{self.token}"
        self.last_update_id = self.get_last_update_id()
        
    def get_last_update_id(self):
        """Get the last processed update_id from state file."""
        state_file = r"C:\Users\eyeka\AppData\Local\hermes\.telegram_state.json"
        try:
            if os.path.exists(state_file):
                with open(state_file, "r") as f:
                    state = json.load(f)
                return state.get("last_update_id", 0)
        except Exception as e:
            print(f"Warning: Could not read state: {e}")
        return 0
    
    def save_state(self, update_id):
        """Save the last processed update_id."""
        state_file = r"C:\Users\eyeka\AppData\Local\hermes\.telegram_state.json"
        try:
            state = {"last_update_id": update_id, "updated_at": datetime.now().isoformat()}
            with open(state_file, "w") as f:
                json.dump(state, f)
        except Exception as e:
            print(f"Warning: Could not save state: {e}")
    
    def get_updates(self):
        """Fetch new messages from Telegram."""
        url = f"{self.base_url}/getUpdates"
        params = {
            "offset": self.last_update_id + 1,
            "timeout": 5,
            "allowed_updates": ["message"]
        }
        
        try:
            response = requests.get(url, params=params, timeout=10)
            response.raise_for_status()
            data = response.json()
            
            if data.get("ok") and data.get("result"):
                # Get the highest update_id
                last = max(data["result"], key=lambda x: x["update_id"])
                self.last_update_id = last["update_id"]
                self.save_state(self.last_update_id)
                return data["result"]
            
            return []
        except Exception as e:
            print(f"Error fetching updates: {e}")
            return []
    
    def send_message(self, chat_id, text, parse_mode="Markdown"):
        """Send a message to a specific chat."""
        url = f"{self.base_url}/sendMessage"
        payload = {
            "chat_id": chat_id,
            "text": text[:4096],  # Telegram limit
            "parse_mode": parse_mode
        }
        
        try:
            response = requests.post(url, json=payload, timeout=10)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            print(f"Error sending message: {e}")
            return None
    
    def process_message(self, message):
        """Process a single message."""
        msg_id = message.get("message", {}).get("message_id")
        chat_id = message.get("message", {}).get("chat", {}).get("id")
        text = message.get("message", {}).get("text", "")
        
        if not text:
            return
        
        print(f"\n[{datetime.now().strftime('%H:%M:%S')}] Message from {chat_id}:")
        print(f"  ID: {msg_id}")
        print(f"  Text: {text[:200]}...")
        
        # Here you would dispatch the message to the agent
        # For now, just acknowledge receipt
        response = self.send_message(
            chat_id,
            f"Received: {text[:100]}{'...' if len(text) > 100 else ''}\n\n— Niles Bot v1.0"
        )
        
        return {
            "message_id": msg_id,
            "chat_id": chat_id,
            "text": text,
            "processed": True
        }
    
    def poll(self):
        """Main polling loop."""
        print(f"\n{'='*60}")
        print("TELEGRAM BOT POLLER — Niles")
        print(f"{'='*60}")
        print(f"Chat ID: {self.chat_id}")
        print(f"Last update_id: {self.last_update_id}")
        print(f"{'='*60}")
        
        messages = self.get_updates()
        
        if not messages:
            print("No new messages.")
            return
        
        print(f"\nProcessing {len(messages)} new message(s)...\n")
        
        results = []
        for msg in messages:
            result = self.process_message(msg)
            results.append(result)
        
        print(f"\nProcessed {len(results)} message(s).")
        return results


def main():
    """Entry point."""
    config = load_config()
    
    if not config["token"]:
        print("ERROR: Telegram bot token not found in config!")
        print("Set TELEGRAM_BOT_TOKEN in environment or .env file.")
        sys.exit(1)
    
    bot = TelegramBot(config)
    bot.poll()


if __name__ == "__main__":
    main()
