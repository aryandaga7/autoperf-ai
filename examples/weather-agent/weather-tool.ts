import { tool } from 'ai';
import { z } from 'zod';

// Mock weather data — deterministic for reproducible evals
const WEATHER_DATA: Record<string, { temperature: number; condition: string; humidity: number; windSpeed: number }> = {
  'san francisco': { temperature: 62, condition: 'Foggy', humidity: 75, windSpeed: 12 },
  'tokyo': { temperature: 78, condition: 'Sunny', humidity: 55, windSpeed: 8 },
  'london': { temperature: 58, condition: 'Rainy', humidity: 85, windSpeed: 15 },
  'seattle': { temperature: 55, condition: 'Rainy', humidity: 90, windSpeed: 10 },
  'paris': { temperature: 68, condition: 'Partly Cloudy', humidity: 60, windSpeed: 9 },
  'new york': { temperature: 72, condition: 'Sunny', humidity: 50, windSpeed: 11 },
};

export const weatherTool = tool({
  description: 'Get the current weather for a given location.',
  inputSchema: z.object({
    location: z.string().describe('The city name to get weather for'),
  }),
  execute: async ({ location }) => {
    const key = location.toLowerCase().trim();
    const data = WEATHER_DATA[key];
    if (!data) {
      return { error: `No weather data available for "${location}".` };
    }
    return {
      location,
      temperature: data.temperature,
      unit: 'fahrenheit',
      condition: data.condition,
      humidity: data.humidity,
      windSpeed: data.windSpeed,
    };
  },
});
