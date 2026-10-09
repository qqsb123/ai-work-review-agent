import os
from pathlib import Path
from dataclasses import dataclass
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / '.env')
os.environ.setdefault('HF_HOME', str(ROOT / '.cache' / 'huggingface'))
# Keep local MySQL-independent HTTP services out of an inherited Internet proxy.
# Process-local only; retain the user's bypass list and remote API proxy settings.
proxy_bypass=os.getenv('NO_PROXY') or os.getenv('no_proxy') or ''
os.environ['NO_PROXY']=','.join(dict.fromkeys(['localhost','127.0.0.1','::1',*filter(None,proxy_bypass.split(','))]))

def local_path(value):
    if not value: return None
    path=Path(value)
    return str(path if path.is_absolute() else ROOT/path)

@dataclass
class Settings:
    db_host: str = os.getenv('DB_HOST', '127.0.0.1')
    db_port: int = int(os.getenv('DB_PORT', '3306'))
    db_user: str = os.getenv('DB_USER', 'root')
    db_password: str = os.getenv('DB_PASSWORD', '')
    db_name: str = os.getenv('DB_NAME', 'ai_weekly_report')
    jwt_secret: str = os.getenv('JWT_SECRET', '')
    api_key: str = os.getenv('DEEPSEEK_API_KEY', '')
    agent_model: str = os.getenv('DEEPSEEK_AGENT_MODEL', 'deepseek-flash')
    report_model: str = os.getenv('DEEPSEEK_REPORT_MODEL', 'deepseek-chat')
    qdrant_url: str = os.getenv('QDRANT_URL', 'http://127.0.0.1:6333')
    qdrant_key: str | None = os.getenv('QDRANT_API_KEY') or None
    embedding_model: str = os.getenv('LOCAL_EMBEDDING_MODEL', 'intfloat/multilingual-e5-small')
    embedding_revision: str = os.getenv('LOCAL_EMBEDDING_REVISION', '614241f622f53c4eeff9890bdc4f31cfecc418b3')
    reranker_model: str = os.getenv('RERANKER_MODEL', 'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1')
    embedding_path: str | None = local_path(os.getenv('LOCAL_EMBEDDING_PATH'))
    reranker_path: str | None = local_path(os.getenv('LOCAL_RERANKER_PATH'))
    model_timeout: float = 60
    retrieval_timeout: float = 30

settings = Settings()
