"""Context ingestion: shared data models plus Slack and file readers."""

import os
import logging
from pathlib import Path
from typing import Dict, List, Optional
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class ContextSource:
    """Represents a source of context data"""
    source_type: str  # 'slack', 'file', 'upload'
    source_name: str
    content: str
    metadata: Dict = field(default_factory=dict)



@dataclass
class AgentResult:
    """Result from the orchestrator agent"""
    success: bool
    next_steps: str
    context_sources: List[ContextSource]
    mcp_response: Optional[Dict] = None
    error: Optional[str] = None



class SlackReader:
    """Read messages from Slack channels"""
    
    def __init__(self, token: str = None):
        self.token = token or os.environ.get('SLACK_BOT_TOKEN')
        self._client = None
    
    @property
    def client(self):
        if self._client is None and self.token:
            try:
                from slack_sdk import WebClient
                self._client = WebClient(token=self.token)
            except ImportError:
                logger.warning("slack_sdk not installed. Run: pip install slack_sdk")
        return self._client
    
    def read_channel(self, channel: str, limit: int = 50) -> ContextSource:
        """Read recent messages from a Slack channel"""
        if not self.client:
            logger.warning(f"Slack client not available, skipping channel: {channel}")
            return ContextSource(
                source_type='slack',
                source_name=channel,
                content=f"[Slack integration not configured for channel: {channel}]",
                metadata={'error': 'No Slack token'}
            )
        
        try:
            # Get channel ID if name provided
            channel_id = channel
            if not channel.startswith('C'):
                channels = self.client.conversations_list()
                for ch in channels['channels']:
                    if ch['name'] == channel:
                        channel_id = ch['id']
                        break
            
            # Fetch messages
            result = self.client.conversations_history(
                channel=channel_id,
                limit=limit
            )
            
            messages = []
            for msg in result.get('messages', []):
                text = msg.get('text', '')
                user = msg.get('user', 'unknown')
                ts = msg.get('ts', '')
                messages.append(f"[{user}]: {text}")
            
            content = "\n".join(messages)
            
            return ContextSource(
                source_type='slack',
                source_name=channel,
                content=content,
                metadata={'message_count': len(messages), 'channel_id': channel_id}
            )
            
        except Exception as e:
            logger.error(f"Error reading Slack channel {channel}: {e}")
            return ContextSource(
                source_type='slack',
                source_name=channel,
                content=f"[Error reading channel: {e}]",
                metadata={'error': str(e)}
            )



class FileReader:
    """Read files from local directories"""
    
    SUPPORTED_EXTENSIONS = {'.txt', '.md', '.json', '.csv', '.log', '.py', '.yaml', '.yml'}
    
    def read_folder(self, folder_path: str, recursive: bool = True) -> List[ContextSource]:
        """Read all supported files from a folder"""
        sources = []
        folder = Path(folder_path)
        
        if not folder.exists():
            logger.warning(f"Folder does not exist: {folder_path}")
            return sources
        
        pattern = '**/*' if recursive else '*'
        
        for file_path in folder.glob(pattern):
            if file_path.is_file() and file_path.suffix.lower() in self.SUPPORTED_EXTENSIONS:
                try:
                    content = file_path.read_text(encoding='utf-8', errors='ignore')
                    sources.append(ContextSource(
                        source_type='file',
                        source_name=str(file_path),
                        content=content[:10000],  # Limit content size
                        metadata={
                            'file_size': file_path.stat().st_size,
                            'extension': file_path.suffix
                        }
                    ))
                    logger.info(f"Read file: {file_path}")
                except Exception as e:
                    logger.error(f"Error reading file {file_path}: {e}")
        
        return sources
    
    def read_file(self, file_path: str) -> ContextSource:
        """Read a single file"""
        path = Path(file_path)
        
        if not path.exists():
            return ContextSource(
                source_type='upload',
                source_name=file_path,
                content=f"[File not found: {file_path}]",
                metadata={'error': 'File not found'}
            )
        
        try:
            content = path.read_text(encoding='utf-8', errors='ignore')
            return ContextSource(
                source_type='upload',
                source_name=file_path,
                content=content[:10000],
                metadata={'file_size': path.stat().st_size}
            )
        except Exception as e:
            return ContextSource(
                source_type='upload',
                source_name=file_path,
                content=f"[Error reading file: {e}]",
                metadata={'error': str(e)}
            )
