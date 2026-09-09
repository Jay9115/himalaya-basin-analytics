import axios from 'axios';

const LLM_BASE_URL = import.meta.env.VITE_LLM_URL || 'http://127.0.0.1:8010';

class LLMService {
  constructor() {
    this.client = axios.create({
      baseURL: LLM_BASE_URL,
      timeout: 300000,
    });
  }

  extractMessage(response) {
    const choice = response?.choices?.[0];
    if (!choice) return '';
    return choice.message?.content || choice.text || '';
  }

  async getHealth(signal) {
    const response = await this.client.get('/health', { signal });
    return response.data;
  }

  async chat(message, options = {}) {
    const response = await this.client.post(
      '/chat',
      {
        message,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
      },
      { signal: options.signal }
    );
    return response.data;
  }

  async generate(promptType, content, options = {}) {
    const response = await this.client.post(
      '/generate',
      {
        prompt_type: promptType,
        content,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
      },
      { signal: options.signal }
    );
    return response.data;
  }
}

export default new LLMService();
